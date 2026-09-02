import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

export const TEMPLATES = join(here, '..', 'templates');
export const TARGET = '.gitagent';

/** Walk up to the git root so `init` from a subdirectory still lands correctly. */
export function repoRoot(from = process.cwd()) {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;  // not a git repo; use cwd
    dir = parent;
  }
}

export function agentDir() { return join(repoRoot(), TARGET); }
