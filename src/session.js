import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { agentDir, repoRoot } from './paths.js';
import { redact } from './provider.js';

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

export function headSha(root = repoRoot()) {
  return git(['rev-parse', 'HEAD'], { root, check: false });
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
  prefix = 'jr-architect',
} = {}) {
  const id = `${stamp()}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = join(agentDir(), '.session', id);
  mkdirSync(dir, { recursive: true });

  const startBranch = currentBranch(root);
  const startSha = headSha(root);
  let workBranch = startBranch;

  if (branch && isRepo(root) && startSha) {
    workBranch = `${prefix}/session-${id}`;
    git(['checkout', '-b', workBranch], { root });
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
export function openAttempt(session, { tier, task, parent = null, reason = null }) {
  const frame = {
    n: session.attempts.length + 1,
    tier,
    task,
    parent,
    reason,
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
  frame.diff = diffSince(session.root, frame.sha);
  record(session, 'attempt.close', {
    n: frame.n, tier: frame.tier, status, reason, steps: frame.steps,
    green: verify?.green ?? null,
    diffLines: frame.diff ? frame.diff.split('\n').length : 0,
  });
  return frame;
}

/** Working-tree diff since a commit, including files the agent created. */
export function diffSince(root, sha) {
  if (!sha) return null;
  git(['add', '--intent-to-add', '--all'], { root, check: false });
  return git(['diff', sha, '--'], { root, check: false }) || null;
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
  git(['reset', '--hard', frame.sha], { root: session.root, check: false });
  // `git clean -fd` removes untracked files, and the session directory is
  // untracked in a repo whose .gitignore does not mention it yet — a run
  // scaffolded by hand, or one whose first attempt fails before init's ignore
  // rules are committed. Excluding it explicitly means the transcript survives
  // a revert regardless of what .gitignore happens to say.
  git(['clean', '-fd', '-e', '.gitagent/.session'], { root: session.root, check: false });
  record(session, 'attempt.revert', { n: frame.n, tier: frame.tier, to: frame.sha });
}

export function commitAttempt(session, frame, message) {
  git(['add', '--all'], { root: session.root, check: false });
  const staged = git(['diff', '--cached', '--name-only'], { root: session.root, check: false });
  if (!staged) return null;
  git(['commit', '-m', message], { root: session.root, check: false });
  const sha = headSha(session.root);
  record(session, 'attempt.commit', { n: frame.n, tier: frame.tier, sha });
  return sha;
}

/**
 * The handoff payload, exactly as DUTIES.md specifies it.
 *
 * "Truncate file contents before truncating this." An escalation that arrives
 * without the failed diffs is just a slower retry — the senior repeats the
 * junior's first attempt with more confidence, which is the single most
 * expensive way this ladder can waste a cycle.
 */
export function handoffPayload(session, { task, to, reason }) {
  const history = session.attempts.map((a) => ({
    n: a.n,
    tier: a.tier,
    status: a.status,
    steps: a.steps,
    reason: a.reason,
    green: a.verify?.green ?? null,
  }));

  const failed = session.attempts.filter((a) => a.diff && a.status !== 'done');
  const last = session.attempts[session.attempts.length - 1];

  return [
    `## Task (unmodified)\n\n${task}`,
    `\n## Why this reached you\n\n${reason}`,
    `\n## Tier history\n\n${history.map((h) => `${h.n}. ${h.tier} — ${h.status}${h.reason ? ` (${h.reason})` : ''}`).join('\n')}`,
    failed.length
      ? `\n## Diffs already attempted — these approaches are ruled out\n\n${failed
          .map((a) => `### attempt ${a.n} (${a.tier}, ${a.status})\n\n\`\`\`diff\n${a.diff}\n\`\`\``)
          .join('\n\n')}`
      : '\n## Diffs already attempted\n\nNone — no attempt produced a diff.',
    last?.verify?.output
      ? `\n## Last build output (${last.verify.label ?? 'unknown command'})\n\n\`\`\`\n${last.verify.output}\n\`\`\``
      : '',
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
