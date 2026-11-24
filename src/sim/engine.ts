/**
 * Deterministic discrete-event scheduler. Time is in simulated milliseconds.
 * Events scheduled for the same instant run in scheduling order.
 */
import { LIMITS } from './limits';

interface ScheduledEvent {
  time: number;
  seq: number;
  run: () => void;
  label: string;
}

export class Engine {
  now = 0;
  private heap: ScheduledEvent[] = [];
  private seq = 0;
  /** Number of events processed in the last advance() call. */
  lastBatch = 0;
  /** True if the last advance() stopped because it hit the per-advance safety cap. */
  overloaded = false;

  get pending(): number {
    return this.heap.length;
  }

  schedule(delayMs: number, run: () => void, label = ''): void {
    const time = this.now + Math.max(0, delayMs);
    this.push({ time, seq: this.seq++, run, label });
  }

  /** Time of the next queued event, or Infinity. */
  peekTime(): number {
    return this.heap[0]?.time ?? Infinity;
  }

  peekLabel(): string | undefined {
    return this.heap[0]?.label;
  }

  /** Run exactly one event (trace mode). Returns false if the queue was empty. */
  step(): boolean {
    const ev = this.pop();
    if (!ev) return false;
    this.now = Math.max(this.now, ev.time);
    ev.run();
    return true;
  }

  /** Advance the clock by dt, running every event due in that window (bounded). */
  advance(dtMs: number): void {
    const target = this.now + Math.max(0, dtMs);
    let count = 0;
    this.overloaded = false;
    while (this.heap.length > 0 && this.peekTime() <= target) {
      if (count >= LIMITS.maxEventsPerAdvance) {
        this.overloaded = true;
        break;
      }
      this.step();
      count++;
    }
    this.lastBatch = count;
    if (!this.overloaded) this.now = target;
  }

  /** Run until no events remain or the time limit passes (tests and objective checks). */
  runUntilIdle(maxMs = 60_000): void {
    const deadline = this.now + maxMs;
    let count = 0;
    while (this.heap.length > 0 && this.peekTime() <= deadline && count < LIMITS.maxEventsPerRun) {
      this.step();
      count++;
    }
  }

  clear(): void {
    this.heap = [];
  }

  // --- binary min-heap on (time, seq) ---
  private less(a: ScheduledEvent, b: ScheduledEvent): boolean {
    return a.time < b.time || (a.time === b.time && a.seq < b.seq);
  }

  private push(ev: ScheduledEvent): void {
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(h[i]!, h[parent]!)) break;
      [h[i], h[parent]] = [h[parent]!, h[i]!];
      i = parent;
    }
  }

  private pop(): ScheduledEvent | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}

/** Small seeded PRNG (mulberry32) so runs are reproducible. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
