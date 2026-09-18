import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { agentDir, repoRoot } from './paths.js';
import { redact } from './provider.js';
import { globToRegExp, normalizePath } from './hooks.js';

/**
 * Session state: the branch the agent works on, the transcript it leaves
 * behind, and the attempt frames the ladder walks.
 *
 * Everything here lives under .gitagent/.session/, which `init` adds to
 * .gitignore. A transcript holds prompts, diffs, and build output — useful for
 * a day, not something to commit to someone's repo forever.
 *
 * The git in this file is the HARNESS, not the agent, and deliberately does
 * not go through checkCommand. That gate exists to stop the model shelling out
 * around the write hooks; routing our own branch and commit calls through it
 * would deadlock the loop against no-force-push on its first commit. The model
 * never reaches these functions — it only ever reaches tools.js.
 */

export function git(args, { root = repoRoot(), check = true } = {}) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (err) {
    if (check) throw new Error(`git ${args[0]} failed: ${firstLine(err.stderr || err.message)}`);
    return null;
  }
}

const firstLine = (s) => String(s ?? '').split('\n').find((l) => l.trim()) ?? '';

export function isRepo(root = repoRoot()) {
  return existsSync(join(root, '.git'));
}

/** Paths with staged or unstaged changes, plus untracked files. */
export function dirtyFiles(root = repoRoot()) {
  const out = git(['status', '--porcelain'], { root, check: false });
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
}

export function currentBranch(root = repoRoot()) {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], { root, check: false });
}

export function branchExists(root, name) {
  return git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { root, check: false }) !== null;
}

export function headSha(root = repoRoot()) {
  return git(['rev-parse', 'HEAD'], { root, check: false });
}

/**
 * Give a folder the one thing a run needs from git: a commit to branch from.
 *
 * Only ever called after the person said yes. Creating a repository in
 * someone's folder is theirs to decide; this makes the decision one keystroke
 * instead of a command they have to go and find.
 *
 * What goes into that first commit matters more than the commit itself, so the
 * ignore rules come first. `.gitagent/.env` holds their key. `node_modules/` is
 * there in any folder where someone has run `npm i` — including `npm i jr-arch`
 * — and committing it is thousands of files nobody wanted.
 */
export function initialCommit(root = repoRoot()) {
  const email = git(['config', 'user.email'], { root, check: false });
  const name = git(['config', 'user.name'], { root, check: false });
  if (!email || !name) {
    return {
      ok: false,
      reason: 'git does not know who you are yet, so it cannot make a commit.',
      help: [
        '  git config --global user.name "Your Name"',
        '  git config --global user.email you@example.com',
      ],
    };
  }

  if (!isRepo(root)) git(['init', '-q'], { root });

  const wanted = ['.gitagent/.env', '.gitagent/.session/'];
  if (existsSync(join(root, 'node_modules'))) wanted.push('node_modules/');
  const ignoreFile = join(root, '.gitignore');
  const current = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8') : '';
  const lines = current.split('\n').map((l) => l.trim());
  const missing = wanted.filter((rule) => !lines.includes(rule));
  if (missing.length) {
    const sep = current && !current.endsWith('\n') ? '\n' : '';
    writeFileSync(ignoreFile, `${current}${sep}${missing.join('\n')}\n`);
  }

  git(['add', '-A'], { root });
  const staged = git(['diff', '--cached', '--name-only'], { root, check: false });
  const files = staged ? staged.split('\n').filter(Boolean) : [];
  // --allow-empty: an empty folder still needs a commit to branch from.
  git(['commit', '-q', '--allow-empty', '-m', 'initial commit'], { root });

  return { ok: true, files: files.length, sha: headSha(root) };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

/**
 * Open a session. Creates .gitagent/.session/<id>/ and, when configured, the
 * branch the agent commits to.
 *
 * The branch matters beyond tidiness: it is what makes an agent run reviewable
 * and abandonable. A run that edits `main` directly leaves the user diffing
 * against their own history to work out what the agent did.
 */
export function openSession({
  root = repoRoot(),
  task = '',
  branch = true,
  prefix = 'jr-arch',
  reuseBranch = null,
} = {}) {
  const id = `${stamp()}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(agentDir(), '.session', id);
  mkdirSync(dir, { recursive: true });

  const startBranch = currentBranch(root);
  const startSha = headSha(root);
  let workBranch = startBranch;

  if (branch && isRepo(root) && startSha) {
    // A resumed run continues on the branch the first one created. Branching
    // again would strand the earlier attempts on a branch nobody looks at, and
    // the whole point of resuming is to keep that work in view.
    if (reuseBranch && reuseBranch !== startBranch && branchExists(root, reuseBranch)) {
      workBranch = reuseBranch;
      git(['checkout', workBranch], { root });
    } else if (reuseBranch === startBranch) {
      workBranch = startBranch;
    } else {
      workBranch = `${prefix}/session-${id}`;
      git(['checkout', '-b', workBranch], { root });
    }
  }

  const session = {
    id,
    dir,
    root,
    task,
    startBranch,
    startSha,
    branch: workBranch,
    branched: workBranch !== startBranch,
    transcript: join(dir, 'transcript.jsonl'),
    attempts: [],
  };

  writeFileSync(join(dir, 'task.md'), `${task}\n`);
  record(session, 'session.open', { id, branch: workBranch, from: startBranch, sha: startSha });
  return session;
}

/**
 * Append one event to the transcript.
 *
 * Redacted on the way in, not on the way out. A key that reaches this file is
 * already on disk in plaintext, and "we scrub it when displaying" is how it
 * ends up in a bug report attachment.
 */
export function record(session, event, data = {}) {
  const key = process.env[session.keyEnv ?? ''] || '';
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...data }, (_k, v) =>
    typeof v === 'string' ? redact(v, key) : v,
  );
  try {
    appendFileSync(session.transcript, `${line}\n`);
  } catch {
    // A run must not die because its own logging failed.
  }
}

// ---------------------------------------------------------------------------
// Attempt frames
// ---------------------------------------------------------------------------

/**
 * One tier's try at the task.
 *
 * Tier lives on the frame rather than in module state because build-doctor
 * runs nested inside another tier's attempt — hooks.js evaluates the scope
 * fence against whichever tier is acting, and a shared "current tier" would
 * read the outer one at exactly the moment it matters.
 */
export function openAttempt(session, { tier, task, parent = null, reason = null, owns = [] }) {
  const frame = {
    n: session.attempts.length + 1,
    tier,
    task,
    parent,
    reason,
    // The agent's declared scope, so a revert and a diff can be narrowed to
    // what this attempt was responsible for.
    owns,
    sha: headSha(session.root),
    steps: 0,
    status: 'running',
    diff: null,
    verify: null,
  };
  session.attempts.push(frame);
  record(session, 'attempt.open', { n: frame.n, tier, parent: parent?.tier ?? null, reason });
  return frame;
}

export function closeAttempt(session, frame, { status, reason = null, verify = null }) {
  frame.status = status;
  frame.reason = reason ?? frame.reason;
  frame.verify = verify;
  frame.diff = diffSince(session.root, frame.sha, attemptPaths(session, frame));

  // The diff goes to its own file rather than into the transcript. It is the
  // one part of an attempt that a later `--resume` genuinely needs — an
  // escalation without the failed diff is just a slower retry — and inlining
  // a few hundred lines of patch per attempt would make the transcript
  // unreadable for the human it is also written for.
  if (frame.diff) {
    try {
      writeFileSync(join(session.dir, `attempt-${frame.n}.diff`), `${frame.diff}\n`);
    } catch { /* the run matters more than its own bookkeeping */ }
  }

  record(session, 'attempt.close', {
    n: frame.n, tier: frame.tier, status, reason, steps: frame.steps,
    green: verify?.green ?? null,
    diffLines: frame.diff ? frame.diff.split('\n').length : 0,
  });
  return frame;
}

/**
 * Working-tree diff since a commit, including files the agent created.
 *
 * Scoped to `paths` when given. In a swarm the whole-tree diff would attribute
 * a sibling's edits to whichever agent happened to close first, and that diff
 * is what a handoff carries as "what I tried".
 */
export function diffSince(root, sha, paths = null) {
  if (!sha) return null;
  const list = paths && paths.length ? paths : null;
  // --intent-to-add makes new files visible to `git diff`. Narrowed to the
  // attempt's own paths so it does not stage a sibling's untracked output.
  git(['add', '--intent-to-add', '--', ...(list ?? ['.'])], { root, check: false });
  return git(['diff', sha, '--', ...(list ?? [])], { root, check: false }) || null;
}

/**
 * Throw away everything an attempt did.
 *
 * Called only after refusing to start on a dirty tree, so the only work this
 * can destroy is the agent's own. That precondition is the entire safety
 * argument for this function — do not call it from anywhere that skips it.
 */
export function revertAttempt(session, frame) {
  if (!frame.sha) return;
  const root = session.root;
  const paths = attemptPaths(session, frame);

  // Only this attempt's own files. A whole-tree `git reset --hard` would also
  // discard a sibling agent's work in a swarm, and in chat it would discard an
  // earlier accepted turn that has not been committed yet. An agent is
  // responsible for what it wrote and for nothing else.
  const restored = [];
  const deleted = [];
  for (const path of paths) {
    if (existedAt(root, frame.sha, path)) {
      git(['checkout', frame.sha, '--', path], { root, check: false });
      restored.push(path);
    } else {
      // Created by this attempt, so removing it returns the tree to where the
      // attempt found it. rmSync rather than `git clean`, which takes no path
      // list and would reach files this attempt never touched.
      try { rmSync(join(root, path), { force: true }); } catch { /* already gone */ }
      deleted.push(path);
    }
  }

  record(session, 'attempt.revert', {
    n: frame.n, tier: frame.tier, to: frame.sha,
    restored: restored.length, deleted: deleted.length,
  });
}

/**
 * Everything this attempt is answerable for.
 *
 * `touched` covers write_file. A run_command can also change files — a
 * formatter, a codegen step — so anything currently dirty inside the agent's
 * declared scope counts too. An agent with no declared scope gets only what it
 * explicitly wrote, because "everything dirty" would sweep up a sibling's work.
 */
export function attemptPaths(session, frame) {
  const paths = new Set(frame.touched ?? []);
  const scope = frame.owns ?? [];
  if (scope.length) {
    for (const path of dirtyFiles(session.root)) {
      if (scope.some((glob) => globToRegExp(glob).test(normalizePath(path, session.root)))) paths.add(path);
    }
  }
  return [...paths];
}

function existedAt(root, sha, path) {
  return git(['cat-file', '-e', `${sha}:${path}`], { root, check: false }) !== null;
}

/**
 * Commit exactly what this attempt is answerable for, and nothing else.
 *
 * This used to be `git add --all` followed by a bare commit, which swept up
 * whatever else happened to be in the tree: a sibling agent's files in a swarm,
 * and — because the chat runs with --allow-dirty — the user's own uncommitted
 * work, all recorded under this agent's name. Worse, the pre-commit gate is
 * evaluated against the attempt's own paths, so anything extra went into
 * history without being scanned at all.
 *
 * `git commit -- <paths>` commits those paths from the working tree regardless
 * of what else is staged, so a pathspec commit cannot pick up a neighbour's
 * change. The add is still needed first: a pathspec does not match a file git
 * has never seen.
 */
export function commitAttempt(session, frame, message) {
  const paths = attemptPaths(session, frame);
  if (!paths.length) return null;

  git(['add', '--', ...paths], { root: session.root, check: false });
  const staged = git(['diff', '--cached', '--name-only', '--', ...paths], { root: session.root, check: false });
  if (!staged) return null;

  git(['commit', '-m', message, '--', ...paths], { root: session.root, check: false });
  const sha = headSha(session.root);
  record(session, 'attempt.commit', { n: frame.n, tier: frame.tier, sha, files: paths.length });
  return sha;
}

// ---------------------------------------------------------------------------
// Resuming
// ---------------------------------------------------------------------------

/** Session ids under .gitagent/.session/, newest first. Ids sort by timestamp. */
export function listSessions(dir = join(agentDir(), '.session')) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Read a finished session back off disk.
 *
 * Deliberately NOT a conversation replay. The message history is not stored,
 * and storing it would mean writing every prompt and every tool result into
 * the user's repo. What a resume actually needs is what DUTIES.md already says
 * a handoff needs: the original task, what was tried, and why it stopped.
 */
export function readSession(id, dir = join(agentDir(), '.session')) {
  const path = join(dir, id);
  if (!existsSync(path)) return null;

  const read = (f) => {
    try { return readFileSync(join(path, f), 'utf8'); } catch { return ''; }
  };

  const events = read('transcript.jsonl')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

  const attempts = [];
  for (const e of events) {
    if (e.event === 'attempt.open') attempts.push({ n: e.n, tier: e.tier, reason: e.reason, status: 'running' });
    if (e.event === 'attempt.close') {
      const a = attempts.find((x) => x.n === e.n);
      if (a) Object.assign(a, { status: e.status, steps: e.steps, green: e.green, reason: e.reason ?? a.reason });
    }
  }
  for (const a of attempts) a.diff = read(`attempt-${a.n}.diff`) || null;

  const open = events.find((e) => e.event === 'session.open');
  const close = events.find((e) => e.event === 'session.close');

  return {
    id,
    dir: path,
    task: read('task.md').trim(),
    branch: open?.branch ?? null,
    startBranch: open?.from ?? null,
    status: close?.status ?? 'incomplete',
    attempts,
  };
}

/**
 * The brief a resumed run starts from.
 *
 * Same shape as a handoff, because it is one: the previous session is handing
 * the task back with everything it learned. Reusing that shape means a resumed
 * tier reads its history in the format it already understands.
 */
export function resumeBrief(prior) {
  const failed = prior.attempts.filter((a) => a.diff);
  return [
    `## Task (unmodified)\n\n${prior.task}`,
    `\n## Why this reached you\n\nA previous run stopped without finishing (${prior.status}). You are picking it up.`,
    `\n## Tier history\n\n${prior.attempts.map((a) => `${a.n}. ${a.tier} — ${a.status}${a.reason ? ` (${a.reason})` : ''}`).join('\n') || 'none recorded'}`,
    failed.length
      ? `\n## Diffs already attempted — these approaches are ruled out\n\n${failed
          .map((a) => `### attempt ${a.n} (${a.tier}, ${a.status})\n\n\`\`\`diff\n${a.diff}\n\`\`\``)
          .join('\n\n')}`
      : '\n## Diffs already attempted\n\nNone were recorded.',
  ].join('\n');
}

export function closeSession(session, { status, summary = '' }) {
  record(session, 'session.close', { status, attempts: session.attempts.length });
  try {
    writeSummary(session, status, summary);
  } catch {
    // Same rule as record(): losing the summary must not lose the run.
  }
}

function writeSummary(session, status, summary) {
  mkdirSync(session.dir, { recursive: true });
  writeFileSync(
    join(session.dir, 'summary.md'),
    [
      `# Session ${session.id}`,
      `\nstatus: ${status}`,
      `branch: ${session.branch}`,
      `\n## Task\n\n${session.task}`,
      `\n## Tier path\n\n${session.attempts.map((a) => `${a.n}. ${a.tier} — ${a.status}`).join('\n') || 'none'}`,
      summary ? `\n## Summary\n\n${summary}` : '',
    ].join('\n'),
  );
}
