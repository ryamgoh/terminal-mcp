/**
 * Raw PTY output addressed by absolute, monotonically increasing cursors (UTF-16 code-unit offsets
 * since the session started). Memory is bounded: whole chunks are dropped from the front once the
 * retained size exceeds `capacity`, and readers that ask for dropped output are told so (`lost`).
 *
 * This is the one piece of bookkeeping no library provides in this shape: rendering, parsing and
 * command tracking are delegated to @xterm/headless; this class only remembers bytes and offsets.
 */
export interface JournalSlice {
  /** Raw text (may contain escape sequences) between `from` and `next`. */
  raw: string;
  /** Effective start (moved forward if the requested cursor pointed at dropped output). */
  from: number;
  /** Cursor to pass to the next read. */
  next: number;
  /** True if output between the requested cursor and `from` was dropped before it was read. */
  lost: boolean;
  /** True if more output exists after `next`. */
  hasMore: boolean;
}

export class Journal {
  private chunks: string[] = [];
  private offsets: number[] = [];
  private retained = 0;
  private _start = 0;
  private _end = 0;

  constructor(private readonly capacity: number) {}

  /** Cursor of the oldest retained character. */
  get start(): number {
    return this._start;
  }

  /** Cursor just after the newest character (what callers store to read only new output). */
  get end(): number {
    return this._end;
  }

  append(text: string): void {
    if (!text) return;
    this.chunks.push(text);
    this.offsets.push(this._end);
    this._end += text.length;
    this.retained += text.length;
    while (this.chunks.length > 1 && this.retained > this.capacity) {
      const dropped = this.chunks.shift()!;
      this.offsets.shift();
      this.retained -= dropped.length;
      this._start += dropped.length;
    }
  }

  /** Read up to `maxChars` raw characters starting at `cursor`. Pages end on a line boundary when possible. */
  read(cursor: number, maxChars: number): JournalSlice {
    const requested = Math.max(0, Math.floor(cursor));
    const lost = requested < this._start;
    const from = Math.min(Math.max(requested, this._start), this._end);
    const until = Math.min(this._end, from + Math.max(1, maxChars));
    let raw = this.collect(from, until);
    let next = until;
    if (until < this._end) {
      const cut = raw.lastIndexOf('\n');
      if (cut > raw.length / 2) {
        raw = raw.slice(0, cut + 1);
        next = from + raw.length;
      }
    }
    return { raw, from, next, lost, hasMore: next < this._end };
  }

  private collect(from: number, until: number): string {
    if (from >= until) return '';
    let lo = 0;
    let hi = this.offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= from) lo = mid;
      else hi = mid - 1;
    }
    const parts: string[] = [];
    for (let i = lo; i < this.chunks.length && this.offsets[i] < until; i++) {
      const chunkStart = this.offsets[i];
      const chunk = this.chunks[i];
      parts.push(chunk.slice(Math.max(0, from - chunkStart), Math.min(chunk.length, until - chunkStart)));
    }
    return parts.join('');
  }
}
