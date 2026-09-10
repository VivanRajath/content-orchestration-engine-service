import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot } from './paths.js';

/**
 * The project's own build or test command.
 *
 * "Verify with the project's own command" is in RULES.md for every tier, and
 * build state is what DUTIES.md entry rule 1 routes on. Both need one honest
 * answer to "is this repo green", so both come through here.
 *
 * Detection is deliberately shallow. Guessing at a bespoke build is worse than
 * admitting we cannot tell: an unknown build state is reported as null, and
 * null is not a pass — checkCommit warns on it, and classify() does not route
 * to build-doctor on it.
 */

const NPM_SCRIPTS = ['test', 'build', 'check', 'lint'];

/**
 * Candidate verify commands, most specific first. Each is argv, never a shell
 * string — this is executed with shell:false like every other command in the
 * tool, so there is nothing to quote and nothing to smuggle.
 */
export function detect(root = repoRoot()) {
  const has = (f) => existsSync(join(root, f));

  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { /* unreadable */ }
    const scripts = pkg.scripts ?? {};
    // The agent runs whatever the project already runs. Preferring `test` over
    // `build` is deliberate: a green build with red tests is not green, and a
    // repo with no test script falls through to build on the next line.
    for (const name of NPM_SCRIPTS) {
      if (typeof scripts[name] === 'string' && scripts[name].trim()) {
        return { argv: [npmClient(root), 'run', name], label: `${npmClient(root)} run ${name}` };
      }
    }
  }

  if (has('Cargo.toml')) return { argv: ['cargo', 'test', '--quiet'], label: 'cargo test' };
  if (has('go.mod')) return { argv: ['go', 'build', './...'], label: 'go build ./...' };
  if (has('pyproject.toml') || has('pytest.ini') || has('tox.ini')) {
    return { argv: ['python', '-m', 'pytest', '-q'], label: 'pytest -q' };
  }
  if (has('Gemfile')) return { argv: ['bundle', 'exec', 'rake', 'test'], label: 'rake test' };
  if (has('pom.xml')) return { argv: ['mvn', '-q', 'test'], label: 'mvn test' };
  if (has('build.gradle') || has('build.gradle.kts')) return { argv: ['gradle', 'test', '-q'], label: 'gradle test' };
  if (has('Makefile')) return { argv: ['make', 'test'], label: 'make test' };

  return null;
}

/**
 * On Windows, npm/pnpm/yarn/gradle are `.cmd` shims. Node refuses to spawn a
 * .cmd without a shell (CVE-2024-27980), and `shell: true` fixes that by
 * concatenating argv into a command line — reintroducing exactly the
 * metacharacter surface that shell:false exists to remove everywhere else here.
 *
 * So: run the shim through cmd.exe with an argv we build ourselves, and refuse
 * outright if any token contains a character cmd would interpret. Every argv
 * this module produces comes from the fixed tables above, so the guard never
 * fires in practice — it is here so that stays true if someone later feeds
 * this function a command that did not.
 */
export function winCmd(bin, args) {
  const tokens = [bin, ...args];
  const unsafe = tokens.find((t) => CMD_META.test(t));
  if (unsafe) {
    throw new Error(`refusing to run "${unsafe}" through cmd.exe — it contains shell metacharacters`);
  }
  return { bin: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', tokens.join(' ')] };
}

const CMD_META = /[&|<>^"'`(){}[\]!%\s;]/;
const SHIMMED = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'gradle', 'mvn', 'bundle', 'tsc', 'eslint']);

/** Windows needs the shim spawned through cmd.exe; every other platform does not. */
export function resolveBin(bin, args, platform = process.platform) {
  if (platform !== 'win32' || !SHIMMED.has(bin)) return { bin, args };
  return winCmd(`${bin}.cmd`, args);
}

/** Lockfile picks the client; running npm in a pnpm repo is its own failure. */
function npmClient(root) {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/**
 * Run the verify command. `green` is true, false, or null for "no command
 * found" — three states, not two, because "we did not check" and "it passed"
 * must never collapse into the same value.
 */
export function verify({ root = repoRoot(), timeout = 300000, command = null } = {}) {
  const cmd = command ?? detect(root);
  if (!cmd) return { green: null, output: '', label: null, reason: 'no build or test command found' };

  const [rawBin, ...rawArgs] = cmd.argv;
  const { bin, args } = resolveBin(rawBin, rawArgs);
  try {
    const out = execFileSync(bin, args, {
      cwd: root,
      timeout,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { green: true, output: tail(out), label: cmd.label };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { green: null, output: '', label: cmd.label, reason: `${rawBin} is not installed` };
    }
    const output = tail(`${err.stdout ?? ''}${err.stderr ?? ''}` || err.message);
    // A timeout is not a red build. Reporting it as one sends build-doctor
    // after a bug that is not there.
    if (err.killed || err.signal === 'SIGTERM') {
      return { green: null, output, label: cmd.label, reason: `timed out after ${timeout / 1000}s` };
    }
    return { green: false, output, label: cmd.label };
  }
}

/**
 * Build output is head-and-tail, not truncated at one end.
 *
 * The failing assertion is usually near the end; the command that produced it
 * and the first error are at the start. Keeping only one end of a 4000-line
 * test log routinely loses the actual cause.
 */
export function tail(text, limit = 6000) {
  const s = String(text ?? '').trim();
  if (s.length <= limit) return s;
  const half = Math.floor(limit / 2);
  return `${s.slice(0, half)}\n\n… [${s.length - limit} characters omitted] …\n\n${s.slice(-half)}`;
}
