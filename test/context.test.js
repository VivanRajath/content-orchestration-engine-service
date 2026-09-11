import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newLedger, reconcile, compile } from '../src/context.js';

/**
 * The ledger exists so a handoff survives a change of model. These tests are
 * mostly about the trust boundary: a worker emits claims, and only the harness
 * can stamp something verified.
 */

const ledgerWith = (fn) => {
  const l = newLedger('add a --json flag');
  fn?.(l);
  return l;
};

describe('reconcile — claims versus records', () => {
  test('a file the harness saw written is recorded verified', () => {
    const l = ledgerWith();
    reconcile(l, {
      tier: 'junior-dev',
      claims: { completed: [{ what: 'added the flag', files: ['src/cli.js'] }] },
      observed: { touched: ['src/cli.js'] },
      status: 'handoff',
    });
    assert.equal(l.completed[0].verified, true);
    assert.equal(l.artifacts[0].path, 'src/cli.js');
    assert.equal(l.artifacts[0].verified, true);
  });

  // Invariant 2: naming a file in prose is not evidence it was written.
  test('a file named only in prose is recorded unverified', () => {
    const l = ledgerWith();
    reconcile(l, {
      tier: 'junior-dev',
      claims: { completed: [{ what: 'added the flag', files: ['src/imaginary.js'] }] },
      observed: { touched: [] },
      status: 'handoff',
    });
    assert.equal(l.completed[0].verified, false);
    assert.deepEqual(l.artifacts, []);
  });

  // Invariant 4: provenance is the engine's to write.
  test('every record carries engine-stamped provenance', () => {
    const l = ledgerWith();
    reconcile(l, {
      tier: 'senior-dev',
      claims: { decisions: [{ what: 'used a flag', why: 'matches the existing CLI' }], recorded_by: 'LIAR' },
      observed: {},
      status: 'handoff',
    });
    assert.equal(l.decisions[0].recorded_by, 'senior-dev');
    assert.ok(l.decisions[0].recorded_at);
  });

  // Invariant 1: closing an issue is a claim about the world.
  test('an unverified claim does not close an issue', () => {
    const l = ledgerWith();
    reconcile(l, { tier: 'junior-dev', claims: { issues: ['tests fail on windows'] }, observed: {}, status: 'handoff' });
    reconcile(l, { tier: 'senior-dev', claims: { resolved: ['tests fail on windows'] }, observed: { green: false }, status: 'handoff' });
    assert.equal(l.issues[0].open, true, 'a red build must not close an issue');
  });

  test('a green build does close it', () => {
    const l = ledgerWith();
    reconcile(l, { tier: 'junior-dev', claims: { issues: ['tests fail on windows'] }, observed: {}, status: 'handoff' });
    reconcile(l, { tier: 'senior-dev', claims: { resolved: ['tests fail on windows'] }, observed: { green: true }, status: 'handoff' });
    assert.equal(l.issues[0].open, false);
  });

  // Invariant 3, and the one that matters most in practice: a successor that
  // can drop the predecessor's failed approach will re-attempt it.
  test('failed attempts are append-only and survive later workers', () => {
    const l = ledgerWith();
    reconcile(l, { tier: 'junior-dev', claims: { approach: 'patched the parser' }, observed: { reason: 'broke the tests' }, status: 'failed' });
    reconcile(l, { tier: 'senior-dev', claims: { failed: [], approach: 'rewrote the parser' }, observed: {}, status: 'failed' });
    assert.equal(l.failed.length, 2);
    assert.match(l.failed[0].approach, /patched the parser/);
    assert.match(l.failed[0].why, /broke the tests/);
  });

  test('a successful attempt records no failure', () => {
    const l = ledgerWith();
    reconcile(l, { tier: 'junior-dev', claims: { approach: 'did the thing' }, observed: {}, status: 'done' });
    assert.deepEqual(l.failed, []);
  });

  test('malformed claims do not throw', () => {
    const l = ledgerWith();
    reconcile(l, { tier: 'junior-dev', claims: { decisions: 'not an array', completed: null }, observed: {}, status: 'handoff' });
    assert.equal(l.decisions.length, 1);
  });
});

describe('compile — the handoff package', () => {
  const full = () => ledgerWith((l) => {
    reconcile(l, {
      tier: 'junior-dev',
      claims: {
        approach: 'added a --json flag to the parser',
        decisions: [{ what: 'reused the existing formatter', why: 'it already handles nesting' }],
        completed: [{ what: 'wired the flag', files: ['src/cli.js'] }],
        issues: ['output is not stable across runs'],
        assumptions: ['the formatter is not used elsewhere'],
        next: 'stabilise the key order',
      },
      observed: { touched: ['src/cli.js'], reason: 'output unstable' },
      status: 'handoff',
    });
  });

  test('carries the task, the reason, and what was ruled out', () => {
    const out = compile(full(), { to: 'senior-dev', reason: 'needs an architectural call' });
    assert.match(out, /add a --json flag/);
    assert.match(out, /needs an architectural call/);
    assert.match(out, /ruled out/);
    assert.match(out, /added a --json flag to the parser/);
    assert.match(out, /stabilise the key order/);
  });

  test('marks unverified claims as claims', () => {
    const out = compile(full(), { to: 'senior-dev' });
    assert.match(out, /claimed, unverified/);
  });

  // The package is provider-neutral on purpose: the successor may be a
  // different model on a different API and cannot read another one's format.
  test('carries no conversation, tool ids, or provider shapes', () => {
    const out = compile(full(), { to: 'senior-dev' });
    for (const leak of ['tool_use', 'tool_call_id', 'assistant', '```diff', 'role']) {
      assert.ok(!out.includes(leak), `package leaked ${leak}`);
    }
  });

  test('stays within the budget', () => {
    const l = ledgerWith();
    for (let i = 0; i < 200; i++) {
      reconcile(l, {
        tier: 'junior-dev',
        claims: { notes: [`note number ${i} with a fair amount of padding text on it`] },
        observed: {},
        status: 'handoff',
      });
    }
    const out = compile(l, { to: 'senior-dev', budget: 1500 });
    assert.ok(out.length < 2600, `package was ${out.length} chars`);
  });

  // A brief that loses the task is not a smaller brief, it is a different task.
  test('the task survives even an absurd budget', () => {
    const out = compile(full(), { to: 'senior-dev', budget: 10 });
    assert.match(out, /add a --json flag/);
    assert.match(out, /Task \(unmodified\)/);
  });

  // A successor that does not know a section was cut assumes the record is
  // complete, and stops asking.
  test('says what it had to omit', () => {
    const l = ledgerWith();
    for (let i = 0; i < 100; i++) {
      reconcile(l, { tier: 'junior-dev', claims: { notes: [`padding note ${i} ${'x'.repeat(60)}`] }, observed: {}, status: 'handoff' });
    }
    const out = compile(l, { to: 'senior-dev', budget: 900 });
    assert.match(out, /Omitted or shortened/);
  });

  test('an empty ledger still produces a usable brief', () => {
    const out = compile(newLedger('do a thing'), { to: 'junior-dev', reason: 'starting' });
    assert.match(out, /do a thing/);
    assert.ok(out.length < 400);
  });

  // The whole point: a compiled package is a fraction of a transcript.
  test('is far smaller than replaying the work would be', () => {
    const l = full();
    const transcriptish = 'x'.repeat(27000);
    const out = compile(l, { to: 'senior-dev' });
    assert.ok(out.length < transcriptish.length / 10, `package was ${out.length} chars`);
  });
});
