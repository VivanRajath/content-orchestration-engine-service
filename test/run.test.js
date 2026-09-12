import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, escalate } from '../src/run.js';
import { TEMPLATES } from '../src/paths.js';

/**
 * The ladder, driven by a scripted model.
 *
 * `run` takes its model call as an injectable, so the escalation rules can be
 * exercised without a key and without paying for a single token. What is being
 * tested is the machinery — attempt counting, handoff routing, reverting a
 * failed attempt, build-doctor returning control — not whether a real model
 * makes good choices.
 */

let seq = 0;
const nextId = () => `call_${++seq}`;

/**
 * A model that replays a fixed script of turns, one per call.
 *
 * Handoff-report calls are answered separately and do not consume a scripted
 * turn: the report is harness infrastructure, not part of the task the test is
 * describing, and threading a canned report through every script would make
 * each case unreadable. `reports` records them so a test can assert on them.
 */
function scripted(turns, report = {}) {
  const calls = [];
  const reports = [];
  const fn = async (_manifest, req) => {
    if (/handing it to someone else/.test(req.system ?? '')) {
      reports.push({ ...req, messages: [...req.messages] });
      return { text: JSON.stringify(report), toolCalls: [], stopReason: 'end_turn' };
    }
    // Snapshot the message list. attempt() mutates one array across turns, so
    // storing the request by reference would make every recorded call show the
    // transcript's final state rather than what this turn actually saw.
    calls.push({ ...req, messages: [...req.messages] });
    const turn = turns[calls.length - 1];
    if (!turn) return { text: 'no more scripted turns', toolCalls: [], stopReason: 'end_turn' };
    return {
      text: turn.text ?? '',
      toolCalls: (turn.tools ?? []).map((t) => ({ id: nextId(), name: t[0], input: t[1] })),
      stopReason: 'tool_use',
    };
  };
  fn.calls = calls;
  fn.reports = reports;
  return fn;
}

const tool = (name, input) => [name, input];

function sandbox({ scripts = { test: 'node -e "process.exit(0)"' }, files = {}, manifest = {}, agentEdits = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jra-run-')));
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts }, null, 2));
  writeFileSync(join(root, 'index.js'), 'export const a = 1;\n');
  mkdirSync(join(root, 'api'), { recursive: true });
  writeFileSync(join(root, 'api', 'handler.js'), 'export function h() {}\n');
  writeFileSync(join(root, 'style.css'), 'body { color: red; }\n');
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);

  const dir = join(root, '.gitagent');
  cpSync(TEMPLATES, dir, { recursive: true });

  // Pin the entry tier so the classifier never calls the model: these tests are
  // about the ladder, and a scripted turn spent on classification is noise.
  // Every manifest edit happens BEFORE the baseline commit — run() refuses a
  // dirty tree, so editing it afterwards would fail the guard, not the case.
  const file = join(dir, 'agent.yaml');
  let text = readFileSync(file, 'utf8').replace('entry: auto', 'entry: junior-dev');
  for (const [from, to] of Object.entries(manifest)) text = text.replace(from, to);
  writeFileSync(file, text);

  // An agent's attempt budget, scope and escalation live in its own front
  // matter now, so a test that needs a different budget edits the agent.
  for (const [name, [from, to]] of Object.entries(agentEdits)) {
    const soul = join(dir, 'agents', name, 'SOUL.md');
    writeFileSync(soul, readFileSync(soul, 'utf8').replace(from, to));
  }

  // What init writes. Without it .gitagent/.session/ is untracked, and the
  // dirty-tree guard would fire on the agent's own transcript.
  writeFileSync(join(root, '.gitignore'), '.gitagent/.env\n.gitagent/.session/\n');

  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '--all');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return { root, dir, git };
}

/** run() reads the repo from cwd, so each case owns the process directory. */
async function inRepo(box, fn) {
  const prev = process.cwd();
  process.chdir(box.root);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
    rmSync(box.root, { recursive: true, force: true });
  }
}

describe('escalate', () => {
  // The agent decides, in its own front matter. Nothing in the harness knows
  // the default names, so a user's own agent can be escalated to.
  const agent = (name, priority, over = {}) => ({ name, priority, owns: [], parallel: false, ...over });
  const defaults = [
    agent('build-doctor', 0, { terminal: true }),
    agent('junior-dev', 20, { escalatesTo: 'senior-dev' }),
    agent('ui-editor', 20, { escalatesTo: 'junior-dev' }),
    agent('senior-dev', 40, { terminal: true }),
  ];

  test('an agent hands to whoever it names', () => {
    assert.equal(escalate('ui-editor', defaults), 'junior-dev');
    assert.equal(escalate('junior-dev', defaults), 'senior-dev');
  });

  // There is nothing above it, and looping is worse than asking.
  test('terminal: true escalates to the human', () => {
    assert.equal(escalate('senior-dev', defaults), null);
    assert.equal(escalate('build-doctor', defaults), null);
  });

  test('with nothing declared, the next agent by priority takes it', () => {
    const plain = [agent('first', 10), agent('second', 20), agent('third', 30)];
    assert.equal(escalate('first', plain), 'second');
    assert.equal(escalate('second', plain), 'third');
    assert.equal(escalate('third', plain), null, 'the last agent has nobody above it');
  });

  // A name that is not installed is a dead end, not a silent fallthrough to
  // somebody else's agent.
  test('naming an uninstalled agent stops rather than guessing', () => {
    const one = [agent('solo', 10, { escalatesTo: 'ghost' })];
    assert.equal(escalate('solo', one), null);
  });

  test('a user agent nobody hard-coded can be escalated to', () => {
    const mine = [agent('scout', 10, { escalatesTo: 'archivist' }), agent('archivist', 90)];
    assert.equal(escalate('scout', mine), 'archivist');
  });

  test('an unknown agent name routes nowhere', () => {
    assert.equal(escalate('nobody', defaults), null);
  });
});

describe('the loop', () => {
  test('a tier that writes and calls done finishes and commits', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const call = scripted([
        { tools: [tool('read_file', { path: 'index.js' })] },
        { tools: [tool('write_file', { path: 'index.js', content: 'export const a = 1;\nexport const hello = () => "hi";\n' })] },
        { tools: [tool('done', { summary: 'Added hello() to index.js' })] },
      ]);
      const out = await run(['add a hello function'], {}, { call });

      assert.equal(out.status, 'done');
      assert.equal(out.tier, 'junior-dev');
      assert.match(readFileSync(join(box.root, 'index.js'), 'utf8'), /hello/);
      const log = execFileSync('git', ['log', '--oneline'], { cwd: box.root, encoding: 'utf8' });
      assert.match(log, /junior-dev: Added hello/);
    });
  });

  test('a run refuses to start on a dirty tree', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      writeFileSync(join(box.root, 'uncommitted.txt'), 'work in progress\n');
      await assert.rejects(
        () => run(['anything'], {}, { call: scripted([]) }),
        /uncommitted change/,
      );
    });
  });

  test('--dry-run classifies and writes nothing', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const out = await run(['do a thing'], { 'dry-run': true }, { call: scripted([]) });
      assert.equal(out.dryRun, true);
      assert.equal(out.tier, 'junior-dev');
      assert.ok(!existsSync(join(box.dir, '.session')), 'no session should be opened');
    });
  });

  // A blocked hook has to come back as a tool error the model can act on. If it
  // threw, the run would die and the block reason would never be read.
  test('a blocked edit is reported to the model, which can then hand off', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const call = scripted([
        { tools: [tool('write_file', { path: 'index.js', content: 'const k = "sk-abcdefghijklmnopqrstuvwxyz0123";\n' })] },
        { tools: [tool('done', { summary: 'Wrote nothing secret in the end' })] },
      ]);
      const out = await run(['add a key'], {}, { call });

      assert.equal(out.status, 'done');
      const secondTurn = call.calls[1];
      const results = secondTurn.messages.at(-1).results;
      assert.equal(results[0].isError, true);
      assert.match(results[0].content, /secret-scan/);
      assert.ok(!readFileSync(join(box.root, 'index.js'), 'utf8').includes('sk-'));
    });
  });

  test('a handoff routes to the named tier and reverts the first attempt', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const call = scripted([
        // junior-dev starts down the wrong path, then recognises the scope
        { tools: [tool('write_file', { path: 'index.js', content: 'export const a = 999;\n' })] },
        { tools: [tool('handoff', { to: 'senior-dev', reason: 'this is cross-cutting' })] },
        // senior-dev picks it up
        { tools: [tool('write_file', { path: 'index.js', content: 'export const a = 1;\nexport const b = 2;\n' })] },
        { tools: [tool('done', { summary: 'Added b' })] },
      ]);
      const out = await run(['restructure things'], {}, { call });

      assert.equal(out.status, 'done');
      assert.equal(out.tier, 'senior-dev');
      const final = readFileSync(join(box.root, 'index.js'), 'utf8');
      assert.match(final, /export const b = 2/);
      // The junior's abandoned edit must not survive into the senior's result.
      assert.ok(!final.includes('999'), 'the reverted attempt leaked into the tree');
    });
  });

  // The brief is compiled from the ledger, not replayed from the transcript.
  // Raw diffs deliberately do NOT travel — replaying them is the cost this is
  // built to avoid. What must travel is whatever rules an approach out.
  test('the handoff brief is a compiled record, not a transcript', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const call = scripted([
        { tools: [tool('write_file', { path: 'index.js', content: 'export const a = 42;\n' })] },
        { tools: [tool('handoff', { to: 'senior-dev', reason: 'out of my depth' })] },
        { tools: [tool('done', { summary: 'handled' })] },
      ], { approach: 'renamed the export to 42', next: 'try the config layer instead' });
      await run(['do the thing'], {}, { call });

      const seniorBrief = call.calls[2].messages[0].content;
      assert.match(seniorBrief, /Task \(unmodified\)/);
      assert.match(seniorBrief, /do the thing/);
      assert.match(seniorBrief, /out of my depth/);
      assert.match(seniorBrief, /ruled out/, 'the failed approach must travel');
      assert.match(seniorBrief, /renamed the export to 42/);
      assert.match(seniorBrief, /index\.js/, 'files the harness saw written must travel');
      assert.ok(!seniorBrief.includes('```diff'), 'raw diffs must not be replayed');
    });
  });

  test('the handoff report is a separate call from the task turn', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const call = scripted([
        { tools: [tool('write_file', { path: 'index.js', content: 'export const a = 7;\n' })] },
        { tools: [tool('handoff', { to: 'senior-dev', reason: 'not mine' })] },
        { tools: [tool('done', { summary: 'ok' })] },
      ]);
      await run(['a task'], {}, { call });

      assert.equal(call.reports.length, 1, 'exactly one handoff report per handoff');
      // Asking for the work and the report in one prompt biases both.
      assert.ok(!call.reports[0].tools, 'the report call must not carry tools');
      assert.match(call.reports[0].messages[0].content, /junior-dev/);
    });
  });

  test('senior-dev is terminal — it stops rather than escalating further', async () => {
    const box = sandbox({ manifest: { 'entry: junior-dev': 'entry: senior-dev' } });
    await inRepo(box, async () => {
      // Prose with no tool call on the first step is a failed attempt.
      const call = scripted([{ text: 'I am thinking about it.' }, { text: 'Still thinking.' }]);
      const out = await run(['impossible task'], {}, { call });

      assert.equal(out.status, 'stopped');
      assert.equal(out.tier, 'senior-dev');
      assert.match(out.reason, /terminal/);
    });
  });

  test('a red build after done routes to build-doctor, which hands control back', async () => {
    const box = sandbox({ scripts: { test: 'node -e "require(\'fs\').existsSync(\'FIXED\')?process.exit(0):process.exit(1)"' } });
    await inRepo(box, async () => {
      const call = scripted([
        { tools: [tool('write_file', { path: 'index.js', content: 'export const a = 2;\n' })] },
        { tools: [tool('done', { summary: 'changed a' })] },
        // build-doctor runs nested and repairs the build
        { tools: [tool('write_file', { path: 'FIXED', content: 'ok\n' })] },
        { tools: [tool('done', { summary: 'build green' })] },
      ]);
      const out = await run(['change a'], { 'skip-verify': true }, { call });

      assert.equal(out.status, 'done');
      // The FEATURE tier owns the outcome; build-doctor does not inherit it.
      assert.equal(out.tier, 'junior-dev');
      assert.match(out.summary, /changed a/);
      assert.ok(existsSync(join(box.root, 'FIXED')));
    });
  });

  test('a model that only emits prose is told to run doctor', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      const call = scripted([{ text: 'Sure! I would love to help with that.' }]);
      const out = await run(['do a thing'], {}, { call });
      assert.equal(out.status, 'stopped');
      assert.match(out.detail ?? '', /doctor/);
    });
  });

  test('the step ceiling ends an attempt that never finishes', async () => {
    const box = sandbox({ manifest: { 'max_steps: 40': 'max_steps: 3' } });
    await inRepo(box, async () => {
      const spin = Array.from({ length: 40 }, () => ({ tools: [tool('read_file', { path: 'index.js' })] }));
      const out = await run(['spin forever'], {}, { call: scripted(spin) });

      assert.equal(out.status, 'stopped');
      assert.match(out.detail ?? '', /3-step ceiling/);
    });
  });
});

describe('resume', () => {
  test('picks up a stopped session, carrying its failed diffs', async () => {
    const box = sandbox({ manifest: { 'entry: junior-dev': 'entry: senior-dev' } });
    await inRepo(box, async () => {
      // First run stops: senior-dev is terminal and never acts.
      await run(['add a b constant'], {}, {
        call: scripted([
          { tools: [tool('write_file', { path: 'index.js', content: 'export const WRONG = 1;\n' })] },
          { text: 'stuck' }, { text: 'still stuck' }, { text: 'no' },
          { tools: [tool('write_file', { path: 'index.js', content: 'export const ALSO_WRONG = 2;\n' })] },
          { text: 'stuck' }, { text: 'still stuck' }, { text: 'no' },
        ]),
      });

      const call = scripted([
        { tools: [tool('write_file', { path: 'index.js', content: 'export const a = 1;\nexport const b = 2;\n' })] },
        { tools: [tool('done', { summary: 'Added b' })] },
      ]);
      const out = await run([], { resume: true }, { call });

      assert.equal(out.status, 'done');
      const brief = call.calls[0].messages[0].content;
      assert.match(brief, /add a b constant/);
      assert.match(brief, /previous run stopped/);
      assert.match(brief, /WRONG/, 'the earlier diffs must travel into the resumed run');
    });
  });

  test('a resumed run stays on the original session branch', async () => {
    const box = sandbox({ manifest: { 'entry: junior-dev': 'entry: senior-dev' } });
    await inRepo(box, async () => {
      await run(['do a thing'], {}, { call: scripted([{ text: 'no tools' }]) });
      const first = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: box.root, encoding: 'utf8' }).trim();

      await run([], { resume: true }, {
        call: scripted([{ tools: [tool('done', { summary: 'ok' })] }]),
      });
      const after = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: box.root, encoding: 'utf8' }).trim();
      assert.equal(after, first, 'resuming must not open a second branch');
    });
  });

  test('an unknown session id lists the real ones', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      await run(['a task'], {}, { call: scripted([{ text: 'no tools' }]) });
      await assert.rejects(
        () => run([], { resume: 'nope' }, { call: scripted([]) }),
        /No session "nope"[\s\S]*Available:/,
      );
    });
  });

  test('resuming with no sessions at all is a clear error', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      await assert.rejects(() => run([], { resume: true }, { call: scripted([]) }), /No sessions to resume/);
    });
  });

  test('a finished session cannot be resumed', async () => {
    const box = sandbox();
    await inRepo(box, async () => {
      await run(['a task'], {}, {
        call: scripted([{ tools: [tool('done', { summary: 'all good' })] }]),
      });
      await assert.rejects(
        () => run([], { resume: true }, { call: scripted([]) }),
        /finished successfully/,
      );
    });
  });
});

describe('the idle guard', () => {
  // Without it an attempt spends its whole step budget on "Continue" and bills
  // the user for every round trip.
  test('three tool-free replies in a row end the attempt', async () => {
    // One attempt only, so `detail` reports this failure rather than the
    // retry's.
    const box = sandbox({
      manifest: { 'entry: junior-dev': 'entry: senior-dev' },
      agentEdits: { 'senior-dev': ['terminal: true', ['attempts: 1', 'terminal: true'].join('\n')] },
    });
    await inRepo(box, async () => {
      const call = scripted([
        { tools: [tool('read_file', { path: 'index.js' })] },
        { text: 'thinking' }, { text: 'still thinking' }, { text: 'more thinking' },
        { text: 'never reached' },
      ]);
      const out = await run(['spin'], {}, { call });
      assert.equal(out.status, 'stopped');
      assert.match(out.detail ?? '', /no tool call/);
      // 1 tool call + 3 idle replies, then it stops. The fifth is never made.
      assert.ok(call.calls.length <= 8, `made ${call.calls.length} model calls`);
    });
  });
});
