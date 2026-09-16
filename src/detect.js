import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './paths.js';
import { detect as detectVerify } from './verify.js';
import { c, ok, info, warn } from './util.js';

/**
 * What this repo is built out of.
 *
 * The point is not to be a language census — it is to answer the questions the
 * run loop actually asks: which verify command to trust, whether a lockfile is
 * present, and whether the repo is in the state DUTIES.md entry rule 1 routes
 * on. `jr-arch detect` prints that so a user can see what the agent will see
 * before spending a token on it.
 *
 * Everything here is file-presence, never content-sniffing or a model call.
 * A wrong guess about the stack is recoverable; a slow or chatty `detect` is
 * a command nobody runs.
 */

const STACKS = [
  { name: 'Node',    files: ['package.json'],                     lock: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'] },
  { name: 'Deno',    files: ['deno.json', 'deno.jsonc'],           lock: ['deno.lock'] },
  { name: 'Rust',    files: ['Cargo.toml'],                        lock: ['Cargo.lock'] },
  { name: 'Go',      files: ['go.mod'],                            lock: ['go.sum'] },
  { name: 'Python',  files: ['pyproject.toml', 'setup.py', 'requirements.txt'], lock: ['poetry.lock', 'uv.lock', 'Pipfile.lock'] },
  { name: 'Ruby',    files: ['Gemfile'],                           lock: ['Gemfile.lock'] },
  { name: 'Java',    files: ['pom.xml', 'build.gradle', 'build.gradle.kts'], lock: [] },
  { name: 'PHP',     files: ['composer.json'],                     lock: ['composer.lock'] },
  { name: 'Elixir',  files: ['mix.exs'],                           lock: ['mix.lock'] },
  { name: '.NET',    files: ['global.json'],                       lock: ['packages.lock.json'] },
];

const FRAMEWORKS = {
  next: 'Next.js', nuxt: 'Nuxt', '@remix-run/react': 'Remix', astro: 'Astro',
  '@sveltejs/kit': 'SvelteKit', vue: 'Vue', svelte: 'Svelte', react: 'React',
  '@angular/core': 'Angular', express: 'Express', fastify: 'Fastify',
  '@nestjs/core': 'NestJS', vite: 'Vite', tailwindcss: 'Tailwind',
  typescript: 'TypeScript', jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha',
  playwright: 'Playwright', '@playwright/test': 'Playwright', cypress: 'Cypress',
  eslint: 'ESLint', prettier: 'Prettier',
};

export function inspect(root = repoRoot()) {
  const has = (f) => existsSync(join(root, f));

  const stacks = STACKS
    .filter((s) => s.files.some(has))
    .map((s) => ({
      name: s.name,
      manifest: s.files.find(has),
      // A missing lockfile is DUTIES.md entry rule 1 territory: the build is
      // not reproducible, and build-doctor owns that before anything else runs.
      lock: s.lock.find(has) ?? null,
      lockable: s.lock.length > 0,
    }));

  return {
    root,
    stacks,
    frameworks: readFrameworks(root),
    verify: detectVerify(root),
    monorepo: readWorkspaces(root),
    ci: ['.github/workflows', '.gitlab-ci.yml', 'Jenkinsfile', '.circleci'].filter(has),
    container: ['Dockerfile', 'docker-compose.yml', 'compose.yaml', '.devcontainer'].filter(has),
  };
}

function readFrameworks(root) {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return [];
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  // Deduplicated: react and @types/react are one fact, not two.
  return [...new Set(Object.keys(deps).map((d) => FRAMEWORKS[d]).filter(Boolean))];
}

/**
 * Workspace packages, if this is a monorepo.
 *
 * It matters to routing, not to trivia: in a monorepo the entry tier is far
 * more often `senior-dev`, because "one file" in one package is routinely a
 * cross-cutting change in another.
 */
function readWorkspaces(root) {
  const file = join(root, 'package.json');
  if (existsSync(file)) {
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      if (Array.isArray(ws) && ws.length) return { kind: 'npm workspaces', globs: ws };
    } catch { /* unreadable */ }
  }
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) return { kind: 'pnpm workspace', globs: [] };
  if (existsSync(join(root, 'lerna.json'))) return { kind: 'lerna', globs: [] };
  if (existsSync(join(root, 'turbo.json'))) return { kind: 'turborepo', globs: [] };
  for (const dir of ['packages', 'apps']) {
    const p = join(root, dir);
    try {
      if (readdirSync(p, { withFileTypes: true }).some((e) => e.isDirectory() && existsSync(join(p, e.name, 'package.json')))) {
        return { kind: `${dir}/ directory`, globs: [`${dir}/*`] };
      }
    } catch { /* not there */ }
  }
  return null;
}

export async function detect(_positional, flags) {
  const found = inspect();

  if (flags.json) {
    console.log(JSON.stringify(found, null, 2));
    return found;
  }

  console.log();
  if (!found.stacks.length) {
    warn('No recognised stack — no package.json, Cargo.toml, go.mod, or equivalent.');
    info('The agent will run, but with no verify command it cannot tell green from red.');
    console.log();
    return found;
  }

  for (const s of found.stacks) {
    const lock = s.lock ? c.g(s.lock) : s.lockable ? c.y('no lockfile') : c.d('n/a');
    info(`${c.c(s.name.padEnd(10))}${s.manifest.padEnd(22)}${lock}`);
  }
  console.log();

  if (found.frameworks.length) {
    info(`${'uses'.padEnd(10)}${found.frameworks.join(', ')}`);
  }
  if (found.monorepo) {
    info(`${'monorepo'.padEnd(10)}${found.monorepo.kind}${found.monorepo.globs.length ? c.d(`  ${found.monorepo.globs.join(', ')}`) : ''}`);
  }
  if (found.ci.length) info(`${'ci'.padEnd(10)}${found.ci.join(', ')}`);
  if (found.container.length) info(`${'container'.padEnd(10)}${found.container.join(', ')}`);
  console.log();

  if (found.verify) ok(`verify with ${c.c(found.verify.label)}`);
  else warn('No build or test command found — the agent cannot verify its own work.');

  // Not decoration. A missing lockfile is DUTIES.md entry rule 1: a repo whose
  // dependencies are not pinned routes to build-doctor before anything else.
  const unpinned = found.stacks.filter((s) => s.lockable && !s.lock);
  for (const s of unpinned) {
    warn(`${s.name} has no lockfile — a run will likely route to a build-repair agent first.`);
  }
  console.log();
  return found;
}
