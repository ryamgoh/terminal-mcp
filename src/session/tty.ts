import { execFile } from 'node:child_process';

export interface TtyModes {
  echo: boolean;
  canonical: boolean;
}

/**
 * Ask the OS for the PTY's line-discipline flags with the standard `stty` tool. Programs reading a
 * password (getpass, sudo, ssh, gpg) switch ECHO off while keeping canonical line mode, which is a far
 * more reliable signal than guessing from prompt text. Returns null if the probe is unavailable.
 */
export function ttyModes(ptsName: string | undefined): Promise<TtyModes | null> {
  if (!ptsName || process.platform === 'win32') return Promise.resolve(null);
  const flag = process.platform === 'linux' ? '-F' : '-f';
  return new Promise((resolve) => {
    execFile('stty', [flag, ptsName, '-a'], { timeout: 1500 }, (err, stdout) => {
      if (err) return resolve(null);
      const tokens = new Set(stdout.split(/[\s;]+/));
      if (!tokens.has('echo') && !tokens.has('-echo')) return resolve(null);
      resolve({ echo: tokens.has('echo'), canonical: tokens.has('icanon') });
    });
  });
}
