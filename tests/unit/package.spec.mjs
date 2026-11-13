// The runtime file list is what ships (scripts/package.mjs) and what the e2e
// suite loads. Guard it against both missing and leaking files.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, runtimeFiles } from '../../scripts/runtime-files.mjs';

test('contains every file the manifest and pages reference', () => {
  const files = new Set(runtimeFiles());
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const referenced = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  // files the extension loads by path at runtime
  for (const src of ['extension/background.js', 'extension/sidepanel.js']) {
    const text = fs.readFileSync(path.join(ROOT, src), 'utf8');
    for (const [, rel] of text.matchAll(/from '\.\/([^']+)'/g)) referenced.push(`extension/${rel}`);
  }
  referenced.push('cssHoverToJavascript.js', 'extension/picker.js', 'extension/sidepanel.css');
  for (const f of referenced) expect(files, f).toContain(f);
});

test('ships nothing but runtime files', () => {
  for (const f of runtimeFiles()) {
    expect(f).toMatch(/^(manifest\.json|cssHoverToJavascript\.js|extension\/.+\.(js|html|css|png))$/);
  }
});
