import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { checkEdit, checkCommand, checkRead } from './hooks.js';
import { resolveBin, tail } from './verify.js';
import { record } from './session.js';

/**
 * The tools the model gets, and the gate each one passes.
 *
 * Every call goes through hooks.js. The important rule is what happens when a
 * hook blocks: the model gets a tool ERROR describing why, and the loop
 * continues. It does not throw. The block reasons in hooks.js are written as
 * instructions to the agent — "Hand off rather than crossing the boundary",
 * "Remove it or read the value from an environment variable" — and crashing
 * the run would waste every one of them. A model that is told why it was
 * stopped can correct; a model that is killed cannot.
 *
 * Tier comes from the caller's attempt frame on every call, never from module
 * state: build-doctor runs nested inside another tier's attempt, and the scope
 * fence has to be evaluated against whichever tier is actually acting.
 */

const MAX_READ = 200000;
const MAX_LIST = 400;
const COMMAND_TIMEOUT = 120000;
// execFileSync kills the child at one megabyte by default and reports it as a
// SIGTERM, so a command that merely printed a lot looked to the agent like it
// had been killed. See MAX_OUTPUT in verify.js.
const COMMAND_MAX_OUTPUT = 64 * 1024 * 1024;

export const TOOLS = [
  {
    name: 'read_file',
    description:
      'Read a file from the repository. Read before you write. A large file is returned in parts: ' +
      'use start_line to continue from where the last part ended.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative path' },
        start_line: { type: 'integer', description: 'First line to return, counting from 1. Default 1.' },
        line_count: { type: 'integer', description: 'How many lines to return. Default: as many as fit.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List files in the repository, optionally under a subdirectory.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Repo-relative directory, default the root' } },
    },
  },
  {
    name: 'write_file',
    description:
      'Write a file, creating it if needed. Send the COMPLETE new contents, not a patch or a fragment.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative path' },
        content: { type: 'string', description: 'The complete new file contents' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a command. Pass argv as an array of separate strings — ["npm","test"], not "npm test". ' +
      'There is no shell: pipes, redirects, and && do not work and will be treated as literal arguments.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'array', items: { type: 'string' }, description: 'argv, e.g. ["npm","test"]' },
      },
      required: ['command'],
    },
  },
  {
    name: 'handoff',
    description:
      'Give this task to another tier. Use it the moment the task exceeds your scope — that is not ' +
      'a failure, it is the design. Your attempted diff travels with the handoff.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Tier name to hand to' },
        reason: { type: 'string', description: 'Why this is not yours, in one sentence' },
      },
      required: ['to', 'reason'],
    },
  },
  {
    name: 'done',
    description: 'The task is complete and verified. State what changed and where, in one or two lines.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const ok = (content) => ({ content: String(content), isError: false });
const err = (content) => ({ content: String(content), isError: true });

/**
 * Run one tool call. Returns {content, isError, control}.
 *
 * Checkpoints — warnings hooks.js marks checkpoint:true — are asked through
 * `ctx.approve` BEFORE the action happens. They used to travel back to run.js
 * alongside the result, which meant `npm install` had already run by the time
 * anyone was asked "Allow?": the question was decoration on something already
 * done. A declined checkpoint is a tool error, like a blocked hook, so the model
 * can take another approach or hand off.
 */
export async function dispatch(call, ctx) {
  const { name, input = {} } = call;
  const handler = HANDLERS[name];
  if (!handler) return err(`No tool named "${name}". Available: ${TOOLS.map((t) => t.name).join(', ')}`);

  if (input.__parseError !== undefined) {
    // safeParse in provider.js hands this through rather than crashing, so the
    // model can be told its arguments were malformed and try again.
    return err(`Your tool arguments were not valid JSON, so the call was not run. Received: ${input.__parseError}`);
  }

  try {
    const result = await handler(input, ctx);
    record(ctx.session, 'tool', {
      tool: name, tier: ctx.tier,
      path: input.path ?? null,
      command: Array.isArray(input.command) ? input.command.join(' ') : null,
      isError: Boolean(result.isError),
    });
    return result;
  } catch (e) {
    // An unexpected throw is still the model's problem to route around, not a
    // reason to end the run.
    return err(`${name} failed: ${e.message}`);
  }
}

const HANDLERS = {
  read_file(input, ctx) {
    const rel = inside(ctx.root, input.path);
    if (rel.error) return err(rel.error);

    const gate = checkRead(rel.path, ctx.tier, ctx.hooks);
    if (!gate.allowed) return err(blocked(gate));

    const abs = join(ctx.root, rel.path);
    if (!existsSync(abs)) return err(`${rel.path} does not exist.`);
    if (statSync(abs).isDirectory()) return err(`${rel.path} is a directory — use list_files.`);

    const buf = readFileSync(abs);
    if (buf.includes(0)) return err(`${rel.path} is a binary file.`);
    const text = buf.toString('utf8');

    // The ceiling comes from what the key allows per request, not from a
    // constant. It used to be 200,000 characters — around 50,000 tokens, more
    // than an entire minute's allowance on a small plan, so reading one large
    // file guaranteed that every later request in the attempt was refused.
    const ceiling = ctx.readCeiling ?? MAX_READ;
    const all = text.split('\n');
    const total = all.length;

    const start = Math.max(1, Math.floor(Number(input.start_line) || 1));
    if (start > total) return err(`${rel.path} has ${total} lines; there is no line ${start}.`);
    const wanted = Number(input.line_count) > 0 ? Math.floor(Number(input.line_count)) : total;
    const asked = input.start_line !== undefined || input.line_count !== undefined;

    // Whole lines, as many as fit under the ceiling. A part ends on a line
    // boundary so the next one can begin exactly where it stopped.
    const lines = [];
    let size = 0;
    let cutLine = false;
    for (let i = start - 1; i < Math.min(total, start - 1 + wanted); i++) {
      const cost = all[i].length + 1;
      if (lines.length && size + cost > ceiling) break;
      if (cost > ceiling) {
        // One line longer than a whole request — a minified file, usually.
        lines.push(all[i].slice(0, ceiling));
        cutLine = true;
        break;
      }
      lines.push(all[i]);
      size += cost;
    }
    const end = start + lines.length - 1;

    // The whole file, asked for plainly and fitting: returned exactly as it
    // is. Not when a line was cut — a one-line minified file used to match
    // this and come back in full, however large.
    if (!asked && start === 1 && end === total && !cutLine) return ok(text);

    if (cutLine) {
      const long = all[end - 1].length;
      return ok(
        `[${rel.path} · line ${end} of ${total}, first ${ceiling} of ${long} characters]\n` +
        `${lines.join('\n')}\n` +
        `[Line ${end} is ${long} characters long — probably minified — and only this much ` +
        'fits in one request on this key. It cannot be read further by line; work from this part.' +
        (end < total ? ` ${total - end} more lines follow; continue with read_file start_line=${end + 1}.]` : ']'),
      );
    }

    // Otherwise say which part this is, and how to get the next one. This used
    // to suggest `sed`, which does not exist on Windows — every agent that took
    // the advice failed the step, then fell back to one-line node scripts it
    // had to escape by hand.
    const head = `[${rel.path} · lines ${start}-${end} of ${total}]`;
    const tail = end < total
      ? `\n[${total - end} more lines. Continue with read_file start_line=${end + 1}.` +
        (lines.length < wanted && ctx.readCeiling ? ' This part is what fits in one request on this key.]' : ']')
      : '';
    return ok(`${head}\n${lines.join('\n')}${tail}`);
  },

  list_files(input, ctx) {
    const rel = inside(ctx.root, input.path || '.');
    if (rel.error) return err(rel.error);

    const base = join(ctx.root, rel.path);
    if (!existsSync(base)) return err(`${rel.path} does not exist.`);

    const found = [];
    walk(base, ctx.root, found);
    if (!found.length) return ok('(no files)');
    const shown = found.slice(0, MAX_LIST);
    return ok(shown.join('\n') + (found.length > shown.length ? `\n… and ${found.length - shown.length} more` : ''));
  },

  async write_file(input, ctx) {
    const rel = inside(ctx.root, input.path);
    if (rel.error) return err(rel.error);
    if (typeof input.content !== 'string') return err('write_file needs `content` as a string.');

    const abs = join(ctx.root, rel.path);
    // checkEdit needs both sides: it scans only the lines this edit ADDS, so a
    // file that already contains a fixture-shaped string is not blocked forever.
    const before = existsSync(abs) && !statSync(abs).isDirectory() ? readFileSync(abs, 'utf8') : null;
    const gate = checkEdit(rel.path, { before, after: input.content }, ctx.tier, ctx.hooks);
    if (!gate.allowed) return err(blocked(gate));
    if (!(await approved(gate, ctx))) return err(declined(gate));

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, input.content);
    ctx.touched?.add(rel.path);

    const lines = input.content.split('\n').length;
    return ok(`Wrote ${rel.path} (${lines} lines).`);
  },

  async run_command(input, ctx) {
    const argv = input.command;
    if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string')) {
      return err('run_command needs `command` as an array of strings, e.g. ["npm","test"].');
    }

    const gate = checkCommand(argv, ctx.tier, ctx.hooks);
    if (!gate.allowed) return err(blocked(gate));
    if (!(await approved(gate, ctx))) return err(declined(gate));

    let bin, args;
    try {
      ({ bin, args } = resolveBin(argv[0], argv.slice(1)));
    } catch (e) {
      return err(e.message);
    }

    try {
      const out = execFileSync(bin, args, {
        cwd: ctx.root, timeout: COMMAND_TIMEOUT, encoding: 'utf8', stdio: 'pipe',
        maxBuffer: COMMAND_MAX_OUTPUT,
      });
      return ok(tail(out) || '(no output)');
    } catch (e) {
      if (e.code === 'ENOENT') return err(`${argv[0]} is not installed or not on PATH.`);
      if (e.code === 'ENOBUFS') {
        return err(`${argv[0]} printed more than ${COMMAND_MAX_OUTPUT / 1024 / 1024}MB and was stopped. Narrow the command, or write its output to a file.`);
      }
      if (e.killed) return err(`Timed out after ${COMMAND_TIMEOUT / 1000}s.\n${tail(e.stdout ?? '')}`);
      // A non-zero exit is information the model needs, not a harness failure —
      // a failing test IS the answer to "run the tests".
      const output = tail(`${e.stdout ?? ''}${e.stderr ?? ''}`) || e.message;
      return err(`Exit ${e.status}.\n${output}`);
    }
  },

  handoff(input, ctx) {
    const to = String(input.to ?? '').trim();
    if (!to) return err('handoff needs `to`.');
    if (!ctx.tiers.includes(to)) {
      return err(`No tier "${to}". Installed tiers: ${ctx.tiers.join(', ')}.`);
    }
    if (to === ctx.tier) return err(`You are ${ctx.tier}; handing off to yourself is a loop.`);
    return { ...ok(`Handing off to ${to}.`), control: { kind: 'handoff', to, reason: String(input.reason ?? '') } };
  },

  done(input, ctx) {
    return { ...ok('Acknowledged.'), control: { kind: 'done', summary: String(input.summary ?? '') } };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Confine a model-supplied path to the repository.
 *
 * The hooks gate WHICH files may be touched; this gates whether the path is in
 * the repo at all. Both are needed: a scope fence that only matches
 * `**\/api/**` says nothing about `../../.ssh/id_rsa`.
 */
export function inside(root, raw) {
  const p = String(raw ?? '').trim();
  if (!p) return { error: 'path is required.' };
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === '' ) return { path: '.' };
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    return { error: `${p} is outside the repository. Paths must be repo-relative.` };
  }
  return { path: rel.split(sep).join('/') };
}

const IGNORED = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target', '__pycache__', '.venv']);

function walk(dir, root, out, depth = 0) {
  if (out.length > MAX_LIST * 2 || depth > 8) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (IGNORED.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, root, out, depth + 1);
    else out.push(relative(root, abs).split(sep).join('/'));
  }
}

/**
 * Render a block for the model.
 *
 * Named hooks, with their reasons, and no apology. The model needs to know
 * which rule stopped it so it can either fix the edit or hand off — a generic
 * "not permitted" produces a retry of the same thing.
 */
function blocked(gate) {
  return [
    'Blocked by the repository guardrails:',
    ...gate.blocked.map((b) => `  - ${b.hook}: ${b.reason}`),
    '',
    'This is enforced by the harness, not by your own rules file, so retrying the same edit will fail again.',
  ].join('\n');
}

const checkpoints = (gate) => (gate.warnings ?? []).filter((w) => w.checkpoint);

/**
 * Ask every checkpoint on a gate, in order, before anything happens.
 *
 * With no one to ask — no `ctx.approve` — the answer is no. A checkpoint exists
 * because a human must decide, and a caller that cannot reach one must not be
 * the thing that decides yes.
 */
async function approved(gate, ctx) {
  const cps = checkpoints(gate);
  if (!cps.length) return true;
  if (typeof ctx.approve !== 'function') return false;
  for (const cp of cps) {
    if (!(await ctx.approve(cp))) return false;
  }
  return true;
}

function declined(gate) {
  return [
    'Not done — this needs human approval, and it was not given:',
    ...checkpoints(gate).map((w) => `  - ${w.hook}: ${w.reason}`),
    '',
    'Nothing was changed. Find another way that avoids it, or hand off and say why it is needed.',
  ].join('\n');
}
