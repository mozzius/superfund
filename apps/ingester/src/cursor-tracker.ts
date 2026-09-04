interface CursorSink {
  updateCursor(cursor: number): void;
}

interface PendingCursor {
  cursor: number;
  complete: boolean;
}

/**
 * Advances a cursor only through a contiguous prefix of completed events.
 * Jetstream does not await async listeners, so handlers may finish out of order.
 */
export class CursorTracker {
  readonly #sink: CursorSink;
  readonly #pending: PendingCursor[] = [];
  #latestSeen: number | undefined;

  constructor(sink: CursorSink) {
    this.#sink = sink;
  }

  begin(cursor: number): () => void {
    this.#see(cursor);
    const entry = { cursor, complete: false };
    this.#pending.push(entry);
    return () => {
      if (entry.complete) return;
      entry.complete = true;
      this.#advance();
    };
  }

  skip(cursor: number): void {
    if (!Number.isFinite(cursor)) return;
    this.#see(cursor);
    if (this.#pending.length === 0) this.#sink.updateCursor(cursor);
  }

  #see(cursor: number): void {
    if (!Number.isFinite(cursor)) return;
    this.#latestSeen = Math.max(this.#latestSeen ?? cursor, cursor);
  }

  #advance(): void {
    let lastCompleted: number | undefined;
    while (this.#pending[0]?.complete) {
      lastCompleted = this.#pending.shift()!.cursor;
    }
    if (lastCompleted === undefined) return;
    this.#sink.updateCursor(
      this.#pending.length === 0 ? this.#latestSeen! : lastCompleted,
    );
  }
}
