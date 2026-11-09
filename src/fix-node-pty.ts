import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * node-pty 1.1.0 (the current stable release) publishes its macOS `spawn-helper` without the execute
 * bit, so every spawn on a Mac fails with "posix_spawnp failed" (microsoft/node-pty#850, fixed only in
 * the 1.2.0 betas). Restore the bit if needed. Runs from `postinstall` and again at server start, so it
 * also covers installs made with --ignore-scripts. Returns the files it changed.
 */
export function ensureSpawnHelperExecutable(): string[] {
  const fixed: string[] = [];
  let root: string;
  try {
    root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    return fixed;
  }
  const prebuilds = path.join(root, 'prebuilds');
  if (!fs.existsSync(prebuilds)) return fixed;
  for (const dir of fs.readdirSync(prebuilds)) {
    if (!dir.startsWith('darwin-')) continue;
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    try {
      const mode = fs.statSync(helper).mode;
      if ((mode & 0o111) !== 0o111) {
        fs.chmodSync(helper, mode | 0o755);
        fixed.push(helper);
      }
    } catch {
      // missing helper or read-only install: node-pty will report its own error
    }
  }
  return fixed;
}
