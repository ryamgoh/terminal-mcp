// postinstall: restore the execute bit on node-pty's macOS spawn-helper (microsoft/node-pty#850).
// Uses the compiled helper when present; falls back to an inline copy before the first build.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

try {
  const root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  const prebuilds = path.join(root, 'prebuilds');
  for (const dir of fs.existsSync(prebuilds) ? fs.readdirSync(prebuilds) : []) {
    if (!dir.startsWith('darwin-')) continue;
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (!fs.existsSync(helper)) continue;
    const mode = fs.statSync(helper).mode;
    if ((mode & 0o111) !== 0o111) {
      fs.chmodSync(helper, mode | 0o755);
      if (process.platform === 'darwin') console.log(`terminal-mcp: made ${path.relative(process.cwd(), helper)} executable (node-pty#850)`);
    }
  }
} catch (err) {
  console.warn(`terminal-mcp: could not check node-pty spawn-helper permissions: ${err.message}`);
}
