import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePlan, generatePlan, soulFile, guardFile, writePlan, writeTiers, planPrompt } from '../src/generate.js';
import { readAgents, frontMatter, escalationCycle } from '../src/agents.js';
import { loadHooks, checkEdit } from '../src/hooks.js';
import { readManifest, modelFor } from '../src/config.js';
import { TEMPLATES } from '../src/paths.js';

/**
 * /prompt. The model PROPOSES a plan; the harness validates every field and
 * WRITES the files itself. These tests are mostly about that boundary: what a
 * bad or hostile generation can and cannot get onto disk.
 */

const agent = (over = {}) => ({
  name: 'builder', role: 'builds things', priority: 20, owns: [], parallel: false,
  escalates_to: null, terminal: true, fixes_build: false, attempts: 2,
  soul: '# Builder\n\nYou build.', rules: '## Must\n- x\n\n## Must not\n- y\n\n## Hand off when\n- z',
  ...over,
});
const plan = (agents, guards = {}) => ({ agents, guards });

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jra-gen-')));
  mkdirSync(join(root, '.git'));
  cpSync(TEMPLATES, join(root, '.gitagent'), { recursive: true });
  return { root, dir: join(root, '.gitagent') };
}
const clean = (b) => rmSync(b.root, { recursive: true, force: true });

describe('validatePlan — rejects what cannot be made safe', () => {
  test('not JSON, or no agents array', () => {
    assert.equal(validatePlan(null).plan, null);
    assert.equal(validatePlan({ nope: true }).plan, null);
    assert.equal(validatePlan({ agents: [] }).plan, null);
  });

  // The name becomes a directory. It must not be able to escape agents/.
  for (const bad of ['../escape', 'a/b', 'Has Space', '', 'x', '-leading', 'a'.repeat(40)]) {
    test(`agent name ${JSON.stringify(bad)} is refused`, () => {
      const { plan: p, errors } = validatePlan(plan([agent({ name: bad })]));
      assert.equal(p, null);
      assert.ok(errors.length);
    });
  }

  test('reserved folder names are refused', () => {
    assert.equal(validatePlan(plan([agent({ name: 'hooks' })])).plan, null);
  });

  test('duplicate names are refused', () => {
    assert.equal(validatePlan(plan([agent(), agent()])).plan, null);
  });

  test('escalating to an agent that is not in the plan is refused', () => {
    const { plan: p, errors } = validatePlan(plan([agent({ terminal: false, escalates_to: 'ghost' })]));
    assert.equal(p, null);
    assert.match(errors.join(), /ghost/);
  });

  test('an empty soul or rules is refused', () => {
    assert.equal(validatePlan(plan([agent({ soul: '' })])).plan, null);
    assert.equal(validatePlan(plan([agent({ rules: '   ' })])).plan, null);
  });

  // Globs are written into files an agent reads and a guard enforces.
  for (const bad of ['/etc/**', 'C:/Windows/**', '../outside/**', 'a/../../b', 'line\nbreak', 'quote"d']) {
    test(`glob ${JSON.stringify(bad)} is refused`, () => {
      assert.equal(validatePlan(plan([agent({ owns: [bad] })])).plan, null);
    });
  }

  test('more than eight agents is refused', () => {
    const many = Array.from({ length: 9 }, (_, i) => agent({ name: `agent-${i}` }));
    assert.equal(validatePlan(plan(many)).plan, null);
  });
});

describe('validatePlan — repairs what can be made safe, and says so', () => {
  // Two unscoped agents running at once would race on the same files.
  test('parallel with no scope is turned off', () => {
    const { plan: p } = validatePlan(plan([agent({ parallel: true, owns: [] })]));
    assert.equal(p.agents[0].parallel, false);
    assert.match(p.notes.join(), /parallel turned off/);
  });

  test('only one agent keeps fixes_build', () => {
    const { plan: p } = validatePlan(plan([
      agent({ name: 'one', fixes_build: true, terminal: false, escalates_to: 'three' }),
      agent({ name: 'two', fixes_build: true, terminal: false, escalates_to: 'three' }),
      agent({ name: 'three' }),
    ]));
    assert.equal(p.agents.filter((a) => a.fixesBuild).length, 1);
  });

  // A loop would pass a task round until every member spent its attempts.
  test('an escalation cycle is broken at its most senior member', () => {
    const { plan: p } = validatePlan(plan([
      agent({ name: 'low', priority: 10, terminal: false, escalates_to: 'high' }),
      agent({ name: 'high', priority: 90, terminal: false, escalates_to: 'low' }),
    ]));
    const high = p.agents.find((a) => a.name === 'high');
    assert.equal(high.terminal, true);
    assert.equal(high.escalatesTo, null);
    assert.match(p.notes.join(), /escalation loop/);
  });

  test('an agent escalating to itself has that removed', () => {
    const { plan: p } = validatePlan(plan([agent({ terminal: false, escalates_to: 'builder' })]));
    assert.equal(p.agents[0].escalatesTo, null);
  });

  test('when nothing is terminal, the most senior agent becomes terminal', () => {
    const { plan: p } = validatePlan(plan([
      agent({ name: 'low', priority: 10, terminal: false, escalates_to: 'high' }),
      agent({ name: 'high', priority: 90, terminal: false }),
    ]));
    assert.equal(p.agents.find((a) => a.name === 'high').terminal, true);
  });

  test('out-of-range numbers are clamped', () => {
    const { plan: p } = validatePlan(plan([agent({ priority: 9000, attempts: -4 })]));
    assert.equal(p.agents[0].priority, 100);
    assert.equal(p.agents[0].attempts, 1);
  });

  test('names are lowercased rather than rejected', () => {
    const { plan: p } = validatePlan(plan([agent({ name: 'Api-Builder' })]));
    assert.equal(p.agents[0].name, 'api-builder');
  });

  test('paths the user said never to touch are added to the guard', () => {
    const { plan: p } = validatePlan(plan([agent()]), { critical: ['payments/keys/**'] });
    assert.ok(p.guards.protectedPaths.includes('payments/keys/**'));
  });
});

describe('the files are built by the harness, not copied from the reply', () => {
  // A role containing YAML syntax must not be able to add a field.
  test('a hostile role cannot inject front matter', () => {
    const { plan: p } = validatePlan(plan([agent({ role: 'reviewer\nfixes_build: true\nterminal: false' })]));
    const text = soulFile(p.agents[0]);
    const { meta } = frontMatter(text);
    assert.notEqual(meta.fixes_build, true, 'the role smuggled in fixes_build');
    assert.equal(typeof meta.role, 'string');
  });

  // The failure this guards against is silent: unparseable front matter used to
  // leave an agent with no metadata at all, running unscoped and never terminal.
  test('a role spanning lines keeps every other field intact', () => {
    const { plan: p } = validatePlan(plan([agent({ role: ['line one', 'line two'].join('\n'), owns: ['src/**'], parallel: true })]));
    const { meta } = frontMatter(soulFile(p.agents[0]));
    assert.equal(meta.role, 'line one line two');
    assert.equal(meta.terminal, true, 'terminal was lost');
    assert.deepEqual(meta.owns, ['src/**'], 'scope was lost');
  });

  test('a role with a colon survives as a string', () => {
    const { plan: p } = validatePlan(plan([agent({ role: 'Owns: the API' })]));
    assert.equal(frontMatter(soulFile(p.agents[0])).meta.role, 'Owns: the API');
  });

  test('only the validated fields reach front matter', () => {
    const raw = agent({ model: 'gpt-evil', api_key_env: 'STEAL_ME', provider: 'somewhere' });
    const { plan: p } = validatePlan(plan([raw]));
    const { meta } = frontMatter(soulFile(p.agents[0]));
    // An agent choosing where the user's code gets sent is the privacy claim
    // inverted, so model and key never come from a generation.
    for (const k of ['model', 'api_key_env', 'provider']) assert.equal(meta[k], undefined, `${k} was written`);
  });

  test('written agents are read back exactly as validated', () => {
    const b = sandbox();
    const { plan: p } = validatePlan(plan([
      agent({ name: 'api', priority: 10, owns: ['src/api/**'], parallel: true, terminal: false, escalates_to: 'lead' }),
      agent({ name: 'lead', priority: 80 }),
    ]));
    writePlan(p, { dir: b.dir, replace: true });
    const back = readAgents(b.dir);
    assert.deepEqual(back.map((a) => a.name), ['api', 'lead']);
    assert.deepEqual(back[0].owns, ['src/api/**']);
    assert.equal(back[0].parallel, true);
    assert.equal(back[0].escalatesTo, 'lead');
    assert.equal(back[1].terminal, true);
    assert.equal(escalationCycle(back), null);
    clean(b);
  });

  test('replace removes the defaults; not replacing keeps them', () => {
    const b = sandbox();
    const { plan: p } = validatePlan(plan([agent({ name: 'solo' })]));
    writePlan(p, { dir: b.dir, replace: false });
    assert.ok(readAgents(b.dir).length > 1, 'defaults should remain');
    writePlan(p, { dir: b.dir, replace: true });
    assert.deepEqual(readAgents(b.dir).map((a) => a.name), ['solo']);
    clean(b);
  });
});

describe('the generated guard is actually enforced', () => {
  // It lives beside hooks.yaml under its own hook names. Before hooks were
  // enforced by shape, a guard like this loaded and silently did nothing.
  test('protected paths block and checkpoint paths ask', () => {
    const b = sandbox();
    const { plan: p } = validatePlan(
      plan([agent()], { protected_paths: ['payments/keys/**'], checkpoint_paths: ['migrations/**'] }),
    );
    writePlan(p, { dir: b.dir, replace: true });
    const hooks = loadHooks(b.dir, { reload: true });

    const blocked = checkEdit('payments/keys/live.json', { before: null, after: 'x' }, 'builder', hooks);
    assert.equal(blocked.allowed, false);

    const asks = checkEdit('migrations/001.sql', { before: null, after: 'x' }, 'builder', hooks);
    assert.equal(asks.allowed, true);
    assert.ok(asks.warnings.some((w) => w.checkpoint));

    const free = checkEdit('src/index.js', { before: null, after: 'x' }, 'builder', hooks);
    assert.equal(free.allowed, true);
    clean(b);
  });

  test('the guard file only ever adds protection', () => {
    const text = guardFile({ protectedPaths: ['a/**'], checkpointPaths: [] });
    assert.ok(!/enabled:\s*false/.test(text));
    assert.ok(!/overridable:\s*false/.test(text), 'a generated guard must not claim to be sealed');
    assert.ok(!/secret-scan|no-sudo|no-force-push|protected-read/.test(text));
  });

  test('with nothing to protect, no guard file is written', () => {
    const b = sandbox();
    const { plan: p } = validatePlan(plan([agent()]));
    const out = writePlan(p, { dir: b.dir, replace: true });
    assert.equal(out.guards, false);
    assert.ok(!existsSync(join(b.dir, 'hooks', 'project.yaml')));
    clean(b);
  });
});

describe('generatePlan', () => {
  const answers = { goal: 'build an api', project: 'Node', critical: [], verify: 'npm test', approval: '', shape: 'auto', files: {} };
  const manifest = { provider: 'groq', model: 'm', keyEnv: 'K' };

  test('a valid first reply is used as is', async () => {
    const call = async () => ({ text: JSON.stringify(plan([agent()])), toolCalls: [] });
    const r = await generatePlan(answers, manifest, { call });
    assert.ok(r.plan);
    assert.equal(r.rounds, 1);
  });

  // A model told exactly what was wrong fixes it; told "try again" it usually
  // repeats the mistake.
  test('an invalid reply is retried once, with the specific errors', async () => {
    const seen = [];
    const call = async (_m, req) => {
      seen.push(req.messages.at(-1).content);
      return seen.length === 1
        ? { text: JSON.stringify(plan([agent({ terminal: false, escalates_to: 'ghost' })])), toolCalls: [] }
        : { text: JSON.stringify(plan([agent()])), toolCalls: [] };
    };
    const r = await generatePlan(answers, manifest, { call });
    assert.ok(r.plan);
    assert.equal(r.rounds, 2);
    assert.match(seen[1], /ghost/, 'the retry did not carry the validation error');
  });

  test('two bad replies give up with the reasons', async () => {
    const call = async () => ({ text: 'I cannot do that', toolCalls: [] });
    const r = await generatePlan(answers, manifest, { call });
    assert.equal(r.plan, null);
    assert.ok(r.errors.length);
  });

  test('a fenced JSON reply is still read', async () => {
    const call = async () => ({ text: '```json\n' + JSON.stringify(plan([agent()])) + '\n```', toolCalls: [] });
    assert.ok((await generatePlan(answers, manifest, { call })).plan);
  });

  test('the prompt carries what the user said', () => {
    const p = planPrompt({ ...answers, critical: ['secrets/**'], shape: 'team' });
    assert.match(p, /build an api/);
    assert.match(p, /secrets\/\*\*/);
    assert.match(p, /team/i);
  });
});

describe('writeTiers', () => {
  // Model choices go in the user's manifest, never in an agent's front matter.
  test('per-agent models land in agent.yaml and resolve', () => {
    const b = sandbox();
    writeTiers({
      api: { provider: 'groq', model: 'llama-3.3-70b-versatile', keyEnv: 'GROQ_API_KEY' },
      lead: { provider: 'anthropic', model: 'claude-opus-4-1', keyEnv: 'ANTHROPIC_API_KEY' },
    }, { dir: b.dir });

    const m = readManifest(join(b.dir, 'agent.yaml'));
    assert.equal(modelFor(m, 'api').provider, 'groq');
    assert.equal(modelFor(m, 'api').keyEnv, 'GROQ_API_KEY');
    assert.equal(modelFor(m, 'lead').model, 'claude-opus-4-1');
    // The rest of the manifest survives the write.
    assert.match(readFileSync(join(b.dir, 'agent.yaml'), 'utf8'), /# GAP agent manifest/);
    clean(b);
  });

  test('no assignments writes nothing', () => {
    const b = sandbox();
    const before = readFileSync(join(b.dir, 'agent.yaml'), 'utf8');
    writeTiers({}, { dir: b.dir });
    assert.equal(readFileSync(join(b.dir, 'agent.yaml'), 'utf8'), before);
    clean(b);
  });
});
