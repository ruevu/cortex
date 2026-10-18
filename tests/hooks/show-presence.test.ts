import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(__dirname, '../../hooks/show-presence.sh');
let server: Server; let base: string; let bodies: any[] = [];
let repo: string; let other: string;

const runHook = (payload: object, env: Record<string, string> = {}) => {
  try {
    execFileSync('bash', [HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, CORTEX_PRESENCE_URL: base, ...env },
    });
  } catch (e) {
    // A hook that exits before reading stdin (CORTEX_PRESENCE=0's fast path,
    // or any early guard) races execFileSync's input write: the pipe closes
    // mid-write and the call throws EPIPE even though the child exited
    // cleanly. That early exit is exactly the behavior under test — tolerate
    // only that shape and rethrow everything else.
    if ((e as NodeJS.ErrnoException)?.code !== 'EPIPE') throw e;
  }
};
// The POST is backgrounded; poll briefly for arrival.
const waitFor = async (n: number) => {
  for (let i = 0; i < 40 && bodies.length < n; i++) await new Promise((r) => setTimeout(r, 50));
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'presence-hook-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'export {}\n');
  writeFileSync(join(repo, 'src', 'b.ts'), 'export {}\n');
  writeFileSync(join(repo, 'src', 'sentinel.ts'), 'export {}\n');
  other = mkdtempSync(join(tmpdir(), 'presence-hook-other-'));
  execFileSync('git', ['init', '-q'], { cwd: other });
  writeFileSync(join(other, 'README.md'), '# other\n');
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { bodies.push({ url: req.url, body: JSON.parse(raw) }); res.writeHead(200).end('{"version":1,"accepted":true}'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => { server.close(); rmSync(repo, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });

describe('show-presence hook', () => {
  it('Read → studied with repo-relative ref', async () => {
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'Read', tool_input: { file_path: join(repo, 'src', 'a.ts') }, cwd: repo });
    await waitFor(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].url).toBe('/api/presence');
    expect(bodies[0].body).toMatchObject({ session_id: 'sess-1', activity: 'studied', refs: ['src/a.ts'] });
    expect(bodies[0].body.repo_path.length).toBeGreaterThan(0);
    expect(bodies[0].body.workspace).toBe(repo.split('/').pop());
  });

  it('Edit → edited', async () => {
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'Edit', tool_input: { file_path: join(repo, 'src', 'a.ts') }, cwd: repo });
    await waitFor(1);
    expect(bodies[0].body.activity).toBe('edited');
  });

  it('drops files outside the git root (scope filter)', async () => {
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'Read', tool_input: { file_path: '/etc/hosts' }, cwd: repo });
    await new Promise((r) => setTimeout(r, 400));
    expect(bodies).toHaveLength(0);
  });

  it('MCP trace_path → traced with qualified name', async () => {
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'mcp__plugin_cortex_cortex__trace_path',
      tool_input: { function_name: 'src/a.ts::fn', repo_path: repo }, cwd: repo });
    await waitFor(1);
    expect(bodies[0].body).toMatchObject({ activity: 'traced', refs: ['src/a.ts::fn'] });
  });

  it('decision why → consulted; decision create → dropped (no double-coverage)', async () => {
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'mcp__plugin_cortex_cortex__decision',
      tool_input: { action: 'why', qualified_name: 'src/a.ts', repo_path: repo }, cwd: repo });
    await waitFor(1);
    expect(bodies[0].body.activity).toBe('consulted');
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'mcp__plugin_cortex_cortex__decision',
      tool_input: { action: 'create', title: 't', repo_path: repo }, cwd: repo });
    await new Promise((r) => setTimeout(r, 400));
    expect(bodies).toHaveLength(0);
  });

  describe('Bash file readers', () => {
    const bash = (command: string, cwd = repo) =>
      runHook({ session_id: 'sess-1', tool_name: 'Bash', tool_input: { command }, cwd });
    /** Exactly `n` beacons, after a grace period for any stragglers. */
    const expectBeacons = async (n: number) => {
      await waitFor(n);
      await new Promise((r) => setTimeout(r, 300));
      expect(bodies).toHaveLength(n);
      return bodies.map((b) => b.body);
    };
    /** Run commands that must post NOTHING, then a sentinel that must post. The
     *  hooks fire in order, so the sentinel's arrival brackets the others' —
     *  stronger than a fixed sleep, which a slow runner can outlast. */
    const expectSilent = async (...commands: string[]) => {
      bodies = [];
      for (const c of commands) bash(c);
      bash('cat src/sentinel.ts');
      const [only] = await expectBeacons(1);
      expect(only).toMatchObject({ refs: ['src/sentinel.ts'] });
    };

    it('cat / sed -n / awk → one studied beacon, refs resolved against cwd', async () => {
      for (const cmd of ['cat src/a.ts', "sed -n '1,20p' src/a.ts", "awk '{ print $1; n++ }' src/a.ts"]) {
        bodies = [];
        bash(cmd);
        const [b] = await expectBeacons(1);
        expect(b, cmd).toMatchObject({ activity: 'studied', refs: ['src/a.ts'] });
      }
    });

    it('follows an absolute cd past a pipe and an &&', async () => {
      bodies = [];
      bash(`cd ${join(repo, 'src')} && sed -n 1p a.ts | head -5`);
      const [b] = await expectBeacons(1);
      expect(b).toMatchObject({ activity: 'studied', refs: ['src/a.ts'] });
    });

    it('a relative cd resolves whether cwd is reported before or after it ran', async () => {
      for (const cwd of [repo, join(repo, 'src')]) {
        bodies = [];
        bash('cd src && sed -n 1p a.ts', cwd);
        const [b] = await expectBeacons(1);
        expect(b, cwd).toMatchObject({ refs: ['src/a.ts'] });
      }
    });

    it('in-place edits are edited, however the flag is spelled and wherever it sits', async () => {
      for (const cmd of ["sed -i '' 's/x/x/' src/a.ts", "sed -Ei 's/x/x/' src/a.ts", "sed -ni 's/x/x/p' src/a.ts",
        "sed 's/x/x/' -i src/a.ts", "gawk -i inplace '{print}' src/a.ts"]) {
        bodies = [];
        bash(cmd);
        const [b] = await expectBeacons(1);
        expect(b, cmd).toMatchObject({ activity: 'edited', refs: ['src/a.ts'] });
      }
    });

    it('a command that edits one file and reads another posts one beacon each', async () => {
      bodies = [];
      bash("sed -i '' 's/x/x/' src/a.ts && cat src/b.ts");
      const got = await expectBeacons(2);
      expect(got.find((b) => b.activity === 'edited')).toMatchObject({ refs: ['src/a.ts'] });
      expect(got.find((b) => b.activity === 'studied')).toMatchObject({ refs: ['src/b.ts'] });
    });

    it('fd redirects do not end the command, and repeats collapse to one ref', async () => {
      bodies = [];
      bash('cat src/a.ts 2>&1 src/b.ts; sed -n 2p src/a.ts >&2; cat src/a.ts');
      const [b] = await expectBeacons(1);
      expect(b.refs).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it("the session's own checkout wins over a stray operand in another repo", async () => {
      bodies = [];
      bash(`cat ${join(other, 'README.md')} src/a.ts`);
      const [b] = await expectBeacons(1);
      expect(b.refs).toEqual(['src/a.ts']);
      expect(b.repo_path.endsWith(repo.split('/').pop()!)).toBe(true);
    });

    it('drops heredoc bodies, redirect targets, non-files, other commands and other repos', async () => {
      await expectSilent(
        "cat > out.sh <<'EOF'\nsed -i 's/x/y/' src/a.ts\ncat src/b.ts\nEOF",
        'cat > src/a.ts',
        'grep -rn foo src/a.ts',
        'echo based on concat',
        `cat src/missing.ts /etc/hosts ${join(other, 'README.md')}`,
        "echo 'unbalanced",
      );
    });
  });

  it('a newline inside an MCP ref stays one ref', async () => {
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'mcp__plugin_cortex_cortex__search_graph',
      tool_input: { name_pattern: 'a\nb', repo_path: repo }, cwd: repo });
    await waitFor(1);
    expect(bodies[0].body.refs).toEqual(['a\nb']);
  });

  it('CORTEX_PRESENCE=0 disables', async () => {
    bodies = [];
    runHook({ session_id: 'sess-1', tool_name: 'Read', tool_input: { file_path: join(repo, 'src', 'a.ts') }, cwd: repo }, { CORTEX_PRESENCE: '0' });
    await new Promise((r) => setTimeout(r, 400));
    expect(bodies).toHaveLength(0);
  });
});
