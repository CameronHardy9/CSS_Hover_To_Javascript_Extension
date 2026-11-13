// Build dist/css-hover-to-js-<version>.zip, ready for the Chrome Web Store or
// "Load unpacked" after unzipping. Contains only the runtime files.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, stage } from './runtime-files.mjs';

const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const dist = path.join(ROOT, 'dist');
const dir = path.join(dist, 'extension');
const zip = path.join(dist, `css-hover-to-js-${version}.zip`);

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(zip, { force: true });
stage(dir);
execFileSync('zip', ['-r', '-X', '-q', zip, '.'], { cwd: dir, stdio: 'inherit' });
console.log(path.relative(ROOT, zip));
