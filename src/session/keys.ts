import { SPECIAL_KEYS } from '../vendor/special-keys.js';

const ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  cr: 'enter',
  bs: 'backspace',
  del: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  pgdn: 'pagedown',
  pgdown: 'pagedown',
  spc: 'space',
};

/** Normalise common spellings (Ctrl-C, C-c, ^C, ESC, M-x) to the vendored table's `ctrl+c` style. */
export function normalizeKeyName(name: string): string {
  let k = name.trim().toLowerCase().replace(/\s+/g, '');
  if (/^\^[a-z]$/.test(k)) k = `ctrl+${k[1]}`;
  k = k
    .replace(/^(c|ctl|control)[-+]/, 'ctrl+')
    .replace(/^(m|meta|opt|option|cmd)[-+]/, 'alt+')
    .replace(/^s[-+]/, 'shift+')
    .replace(/(ctrl|alt|shift)-/g, '$1+');
  const parts = k.split('+');
  parts[parts.length - 1] = ALIASES[parts[parts.length - 1]] ?? parts[parts.length - 1];
  return parts.join('+');
}

/**
 * Encode a named key. When the running program enabled application cursor keys (DECCKM, as vim and
 * less do), xterm reports it via term.modes and unmodified arrows/home/end use SS3 (ESC O x) like a real terminal.
 */
export function encodeKey(name: string, applicationCursorKeys: boolean): string {
  const key = normalizeKeyName(name);
  const seq = SPECIAL_KEYS[key];
  if (seq === undefined) {
    throw new Error(
      `Unknown key "${name}". Examples: enter, tab, escape, backspace, up, down, left, right, home, end, pageup, ` +
        `pagedown, f1-f12, ctrl+c, ctrl+d, ctrl+z, ctrl+l, ctrl+r, alt+b, shift+tab. Send other text via "input".`,
    );
  }
  if (applicationCursorKeys) {
    const m = /^\x1b\[([ABCDHF])$/.exec(seq);
    if (m) return `\x1bO${m[1]}`;
  }
  return seq;
}

export const KNOWN_KEY_COUNT = Object.keys(SPECIAL_KEYS).length;
