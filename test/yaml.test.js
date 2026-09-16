import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from '../src/yaml.js';
import { TEMPLATES } from '../src/paths.js';

const p = (s) => parseYaml(s, 'test.yaml');

describe('the shipped files parse', () => {
  test('hooks.yaml keeps its structure', () => {
    const doc = p(readFileSync(join(TEMPLATES, 'hooks', 'hooks.yaml'), 'utf8'));
    // No post_run: nothing executes that phase, and a hook that never runs is
    // the thing this project refuses to ship.
    assert.deepEqual(Object.keys(doc), ['pre_edit', 'pre_command', 'pre_commit']);

    const scan = doc.pre_edit.find((h) => h.name === 'secret-scan');
    assert.equal(scan.overridable, false);
    assert.deepEqual(scan.checks[0].known_prefixes.slice(0, 2), ['sk-', 'ghp_']);
    assert.equal(scan.checks[1].high_entropy.min_length, 32);
    assert.deepEqual(scan.checks[1].high_entropy.ignore_paths, ['**/*.lock', '**/*.sum', '**/package-lock.json']);

    const fence = doc.pre_edit.find((h) => h.name === 'scope-fence');
    assert.deepEqual(fence.applies_to, ['ui-editor']);
    assert.equal(fence.deny.length, 4);
    assert.match(fence.description, /^Restrict ui-editor to presentational files\. Enforced/);
  });

  test('agent.yaml keeps both name keys distinct', () => {
    const doc = p(readFileSync(join(TEMPLATES, 'agent.yaml'), 'utf8'));
    assert.equal(doc.metadata.name, 'jr-arch');
    assert.equal(doc.model.name, 'claude-sonnet-4-6');
    assert.equal(doc.model.base_url, null);
    assert.equal(doc.model.temperature, 0.2);
    assert.equal(doc.routing.classifier_confidence_floor, 0.6);
    // No `agents:` list: the agents/ directory is what installs an agent, and
    // a manifest list that has to agree with the filesystem is a second source
    // of truth that drifts.
    assert.equal(doc.agents, undefined);
  });

  test('booleans stay booleans, in the files that are actually read', () => {
    // git settings live in agent.yaml because that is the file readManifest
    // reads; default.yaml carries the telemetry claim and nothing else.
    const env = p(readFileSync(join(TEMPLATES, 'config', 'default.yaml'), 'utf8'));
    assert.equal(env.telemetry.enabled, false);
    assert.equal(env.sandbox, undefined, 'a setting nothing implements is not shipped');

    const manifest = p(readFileSync(join(TEMPLATES, 'agent.yaml'), 'utf8'));
    assert.equal(manifest.git.session_branch, true);
    assert.equal(manifest.git.auto_commit, true);
    assert.equal(manifest.git.branch_prefix, 'jr-arch');
  });
});

describe('scalars', () => {
  test('YAML 1.1 booleans, so `overridable: no` is not a truthy string', () => {
    // The dangerous misread: "no" as a string is truthy, which would read as
    // a hook the user believes they switched off but did not.
    assert.equal(p('a: no').a, false);
    assert.equal(p('a: off').a, false);
    assert.equal(p('a: false').a, false);
    assert.equal(p('a: yes').a, true);
    assert.equal(p('a: True').a, true);
  });

  test('null spellings', () => {
    assert.equal(p('a: null').a, null);
    assert.equal(p('a: ~').a, null);
    assert.equal(p('a:').a, null);
  });

  test('numbers and version-like strings', () => {
    assert.equal(p('a: 400').a, 400);
    assert.equal(p('a: -3').a, -3);
    assert.equal(p('a: 4.0').a, 4);
    assert.equal(p('a: 0.1.0').a, '0.1.0');
    assert.equal(p('a: 4g').a, '4g');
  });

  test('quoted strings keep glob and comment characters', () => {
    assert.equal(p('a: "**/*.lock"').a, '**/*.lock');
    assert.equal(p('a: "# not a comment"').a, '# not a comment');
    assert.equal(p("a: 'it''s'").a, "it's");
    assert.equal(p('a: "tab\\there"').a, 'tab\there');
  });

  test('a value keeps a colon that is not a key separator', () => {
    assert.equal(p('base_url: http://localhost:11434/v1').base_url, 'http://localhost:11434/v1');
    assert.equal(p('name: qwen2.5-coder:14b').name, 'qwen2.5-coder:14b');
  });

  test('comments are stripped outside quotes only', () => {
    assert.equal(p('a: 1   # trailing').a, 1);
    assert.equal(p('a: "x#y"').a, 'x#y');
    assert.equal(p('# whole line\na: 1').a, 1);
  });
});

describe('collections', () => {
  test('flow sequences', () => {
    assert.deepEqual(p('a: [x, y]').a, ['x', 'y']);
    assert.deepEqual(p('a: ["x, y", z]').a, ['x, y', 'z']);
    assert.deepEqual(p('a: []').a, []);
  });

  test('block sequences of scalars and of maps', () => {
    assert.deepEqual(p('a:\n  - x\n  - y').a, ['x', 'y']);
    assert.deepEqual(p('a:\n  - n: 1\n    m: 2\n  - n: 3').a, [{ n: 1, m: 2 }, { n: 3 }]);
  });

  test('a sequence may sit at its parent key indentation', () => {
    assert.deepEqual(p('a:\n- x\n- y').a, ['x', 'y']);
  });

  test('nesting a map inside a sequence item inside a map', () => {
    const doc = p('root:\n  - name: a\n    checks:\n      - deep:\n          k: 1\n');
    assert.equal(doc.root[0].checks[0].deep.k, 1);
  });

  test('a blank line does not end a block', () => {
    const doc = p('a:\n  x: 1\n\n  y: 2\n');
    assert.deepEqual(doc.a, { x: 1, y: 2 });
  });

  test('a dedent to column 0 does end a block', () => {
    const doc = p('a:\n  x: 1\nb: 2\n');
    assert.deepEqual(doc, { a: { x: 1 }, b: 2 });
  });
});

describe('block scalars', () => {
  test('folded with strip chomping joins lines with spaces', () => {
    assert.equal(p('a: >-\n  one\n  two\n').a, 'one two');
  });

  test('literal keeps newlines', () => {
    assert.equal(p('a: |-\n  one\n  two\n').a, 'one\ntwo');
  });

  test('a blank line is a paragraph break when folded', () => {
    assert.equal(p('a: >-\n  one\n\n  two\n').a, 'one\ntwo');
  });

  test('a block scalar does not swallow the next key', () => {
    const doc = p('a: >-\n  text\nb: 2\n');
    assert.equal(doc.a, 'text');
    assert.equal(doc.b, 2);
  });
});

describe('unsupported constructs throw rather than guess', () => {
  const cases = [
    ['anchors', 'a: &base\n  x: 1\n', /anchors and aliases/],
    ['aliases', 'a: *base\n', /anchors and aliases/],
    ['merge keys', 'a:\n  <<: *base\n', /merge keys/],
    ['flow mappings', 'a: {x: 1}\n', /flow mappings/],
    ['nested flow collections', 'a: [[1, 2]]\n', /nested flow collections/],
    ['tab indentation', 'a:\n\tx: 1\n', /tab used as indentation/],
    ['a line that is not a pair', 'a:\n  not a pair\n', /expected "key: value"/],
    ['an unterminated string', 'a: "x\n', /unterminated/],
  ];
  for (const [name, text, re] of cases) {
    test(name, () => assert.throws(() => p(text), re));
  }

  test('errors carry the source name and line number', () => {
    assert.throws(() => parseYaml('a: 1\nb: {x: 1}\n', 'hooks/hooks.yaml'), /^Error: hooks\/hooks\.yaml:2:/);
  });
});

test('an empty document is null, not a crash', () => {
  assert.equal(p(''), null);
  assert.equal(p('# only a comment\n'), null);
});
