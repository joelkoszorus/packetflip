/**
 * Background traffic generators: the "users" of the network.
 * Each flow repeats on an interval and records success/failure, which the
 * game layer turns into score, budget and objective progress.
 */
import type { Network } from '../network';
import { Host } from '../devices/host';
import { Cloud } from '../devices/cloud';
import { L3Node } from '../devices/l3';
import { parseIp } from '../net/addr';
import { ping } from '../diag/ping';
import { sendMedia } from '../services/apps';
import { DROP_REASON_TEXT } from '../events';

export type FlowKind = 'ping' | 'web' | 'voip' | 'attack' | 'visit';

export interface FlowSpec {
  id: string;
  kind: FlowKind;
  /** Source device id (for attack/visit: the Cloud). */
  from: string;
  /** Destination: IP literal or hostname. */
  to: string;
  everyMs: number;
  enabled: boolean;
}

export interface FlowStats {
  ok: number;
  fail: number;
  last: string;
  lastOk: boolean | null;
}

export const FLOW_LABEL: Record<FlowKind, string> = {
  ping: 'Ping',
  web: 'Web browsing',
  voip: 'Voice call',
  attack: 'Attack (simulated)',
  visit: 'Internet visitor',
};

export class TrafficManager {
  readonly flows = new Map<string, FlowSpec>();
  readonly stats = new Map<string, FlowStats>();
  private generation = 0;
  private counter = 1;
  onResult?: (flow: FlowSpec, ok: boolean, message: string) => void;

  constructor(private readonly net: Network) {}

  add(spec: Omit<FlowSpec, 'id'> & { id?: string }): FlowSpec {
    const id = spec.id ?? `f${this.counter++}`;
    const flow: FlowSpec = { ...spec, id, everyMs: Math.max(1000, Math.min(120_000, spec.everyMs)) };
    this.flows.set(id, flow);
    this.stats.set(id, { ok: 0, fail: 0, last: 'waiting…', lastOk: null });
    this.arm(flow, this.generation, 500);
    return flow;
  }

  remove(id: string): void {
    this.flows.delete(id);
    this.stats.delete(id);
  }

  /** Re-arm every flow (after the engine queue was cleared). */
  restart(): void {
    this.generation++;
    for (const f of this.flows.values()) this.arm(f, this.generation, 500);
  }

  resetStats(): void {
    for (const s of this.stats.values()) Object.assign(s, { ok: 0, fail: 0, last: 'waiting…', lastOk: null });
  }

  private arm(flow: FlowSpec, gen: number, delay: number): void {
    this.net.engine.schedule(
      delay,
      () => {
        if (gen !== this.generation || this.flows.get(flow.id) !== flow) return;
        if (flow.enabled) this.fire(flow);
        this.arm(flow, gen, flow.everyMs);
      },
      'flow',
    );
  }

  private record(flow: FlowSpec, ok: boolean, message: string): void {
    const s = this.stats.get(flow.id);
    if (!s) return;
    if (ok) s.ok++;
    else s.fail++;
    s.last = message;
    s.lastOk = ok;
    this.onResult?.(flow, ok, message);
  }

  /** Run one iteration of a flow now. */
  fire(flow: FlowSpec): void {
    const src = this.net.device(flow.from);
    if (!(src instanceof L3Node)) return this.record(flow, false, 'Source device is missing');
    switch (flow.kind) {
      case 'web': {
        if (!(src instanceof Host)) return this.record(flow, false, 'Only hosts can browse');
        src.browse(flow.to, (r) => this.record(flow, r.ok, r.message));
        return;
      }
      case 'ping':
      case 'voip': {
        const go = (dst: number | null, msg: string) => {
          if (dst === null) return this.record(flow, false, msg);
          if (flow.kind === 'ping') {
            const s = ping(src, dst, { count: 1 });
            s.onUpdate = () => {
              const r = s.results[0];
              if (r) this.record(flow, r.kind === 'reply', r.kind === 'reply' ? `Reply in ${Math.round(r.rttMs ?? 0)}ms` : r.reason ?? r.kind);
            };
          } else {
            this.trackMedia(flow, src, dst);
          }
        };
        if (src instanceof Host) src.resolve(flow.to, go);
        else go(parseIp(flow.to), 'Destination must be an IP address');
        return;
      }
      case 'attack':
      case 'visit': {
        if (!(src instanceof Cloud)) return this.record(flow, false, 'Attacks and visitors come from the ISP');
        const dst = parseIp(flow.to);
        if (dst === null) return this.record(flow, false, 'Target must be an IP address');
        if (flow.kind === 'visit') src.visit(dst, (r) => this.record(flow, r.ok, r.message));
        else {
          src.attack(dst);
          this.record(flow, true, 'Probe sent');
        }
        return;
      }
    }
  }

  private trackMedia(flow: FlowSpec, src: L3Node, dst: number): void {
    const count = 5;
    let delivered = 0;
    let failed = 0;
    let reason = '';
    const watch = new Set<number>();
    const off = this.net.bus.on((ev) => {
      if (ev.type === 'deliver' && watch.has(ev.packet.id)) delivered++;
      if (ev.type === 'drop' && ev.packet && watch.has(ev.packet.id)) {
        failed++;
        reason = DROP_REASON_TEXT[ev.reason];
      }
    });
    const ids = sendMedia(src, dst, count, 200);
    // ids fill in as packets are sent; watch them as they appear.
    const sync = () => ids.forEach((id) => watch.add(id));
    for (let i = 0; i <= count; i++) this.net.engine.schedule(i * 200 + 1, sync, 'media-sync');
    this.net.engine.schedule(count * 200 + 8000, () => {
      off();
      const ok = delivered >= count - 1;
      this.record(flow, ok, ok ? `Call quality good (${delivered}/${count})` : `Call dropped (${delivered}/${count}) ${reason}`.trim());
      void failed;
    }, 'media-done');
  }
}
