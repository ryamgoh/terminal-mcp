import xterm from '@xterm/headless';
import type { IBuffer, Terminal as TerminalType } from '@xterm/headless';

const { Terminal } = xterm;

/**
 * Join buffer lines [fromLine, toLine) into text, honouring soft wraps (isWrapped) so long lines are
 * not split at the terminal width. If `lastLineEndCol` is given, line `toLine` is included up to that column.
 */
export function bufferText(buf: IBuffer, fromLine: number, toLine: number, lastLineEndCol?: number): string {
  let out = '';
  const last = lastLineEndCol && lastLineEndCol > 0 ? toLine : toLine - 1;
  for (let y = Math.max(0, fromLine); y <= last && y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = y === toLine ? line.translateToString(true, 0, lastLineEndCol) : line.translateToString(true);
    if (y > fromLine && !line.isWrapped) out += '\n';
    out += text;
  }
  return out.replace(/\s+$/u, '');
}

/**
 * Turn raw terminal output into the plain text a person would see, using xterm's own emulator
 * (carriage-return overwrites, progress bars, cursor movement, colours, wraps) instead of regex stripping.
 */
export async function renderText(raw: string, cols: number): Promise<string> {
  if (!raw) return '';
  let newlines = 0;
  for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) newlines++;
  const term: TerminalType = new Terminal({ cols, rows: 24, scrollback: newlines + 64, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => term.write(raw, resolve));
    const buf = term.buffer.active;
    return bufferText(buf, 0, buf.length);
  } finally {
    term.dispose();
  }
}

export interface ScreenSnapshot {
  text: string;
  cursor: { x: number; y: number };
  /** True when a full-screen program (vim, less, top) is using the alternate screen. */
  alternate_screen: boolean;
  cols: number;
  rows: number;
}

/** The visible screen exactly as rendered by the session's emulator. */
export function screenSnapshot(term: TerminalType): ScreenSnapshot {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < term.rows; y++) lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return {
    text: lines.join('\n'),
    cursor: { x: buf.cursorX, y: buf.cursorY },
    alternate_screen: buf.type === 'alternate',
    cols: term.cols,
    rows: term.rows,
  };
}

/** Keep the head and (mostly) the tail of long text, where errors and summaries usually are. */
export function clip(text: string, maxChars: number): { text: string; truncated: boolean; total_chars: number } {
  const total = text.length;
  if (total <= maxChars) return { text, truncated: false, total_chars: total };
  const head = Math.floor(maxChars * 0.25);
  const tail = maxChars - head;
  const omitted = total - head - tail;
  return {
    text: `${text.slice(0, head)}\n... [${omitted} characters omitted] ...\n${text.slice(total - tail)}`,
    truncated: true,
    total_chars: total,
  };
}
