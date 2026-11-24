import type { Endpoint } from './events';

export type CableType = 'copper' | 'fiber';

export interface CableSpec {
  /** Simulated propagation time per hop (ms of game time). Slow enough to watch. */
  latencyMs: number;
  /** Frames per second the cable can carry in each direction. */
  framesPerSecond: number;
  cost: number;
  maxLengthCells: number;
}

export const CABLES: Record<CableType, CableSpec> = {
  copper: { latencyMs: 240, framesPerSecond: 40, cost: 5, maxLengthCells: 12 },
  fiber: { latencyMs: 140, framesPerSecond: 160, cost: 25, maxLengthCells: 60 },
};

export class Link {
  /** Admin/physical state; a cut cable is down. */
  up = true;
  /** Per-direction transmitter busy-until time (a→b and b→a). */
  busyUntil: [number, number] = [0, 0];
  /** Frames sent/dropped counters for stats. */
  sent = 0;
  dropped = 0;

  constructor(
    readonly id: string,
    readonly a: Endpoint,
    readonly b: Endpoint,
    readonly cable: CableType,
  ) {}

  get spec(): CableSpec {
    return CABLES[this.cable];
  }

  /** The other end of the link, given one end's device id + port. */
  peer(device: string, port: number): Endpoint | null {
    if (this.a.device === device && this.a.port === port) return this.b;
    if (this.b.device === device && this.b.port === port) return this.a;
    return null;
  }

  direction(device: string, port: number): 0 | 1 {
    return this.a.device === device && this.a.port === port ? 0 : 1;
  }
}
