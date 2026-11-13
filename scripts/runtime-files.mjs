// The files that make up the shipped extension. The repo root doubles as the
// extension root, so loading or zipping the root as-is would also pick up
// node_modules/, tests/ and these scripts. Everything that needs "the extension"
// -- the release zip and the e2e suite -- goes through this list instead.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEV_ONLY = new Set(['extension/icons/make-icons.mjs']);

/** Git-tracked runtime files, relative to the repo root. */
export function runtimeFiles() {
  return execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f === 'manifest.json' || f === 'cssHoverToJavascript.js' || f.startsWith('extension/'))
    .filter((f) => !DEV_ONLY.has(f));
}

/** Copy the runtime files into `dir` (created if needed). Returns `dir`. */
export function stage(dir) {
  for (const f of runtimeFiles()) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  return dir;
}
