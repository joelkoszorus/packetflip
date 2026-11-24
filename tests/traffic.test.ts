import { describe, expect, it } from 'vitest';
import { Network, TrafficManager } from '../src/sim';
import { cable, host, sw } from './helpers';

describe('traffic flows', () => {
  it('runs periodic ping, web and voice flows and records results', () => {
    const net = new Network();
    const s = sw(net);
    const a = host(net, 'A', '10.0.0.10');
    const srv = host(net, 'SRV', '10.0.0.2');
    srv.http.enabled = true;
    cable(net, a, 0, s, 0);
    cable(net, srv, 0, s, 1);
    const tm = new TrafficManager(net);
    const p = tm.add({ kind: 'ping', from: a.id, to: '10.0.0.2', everyMs: 2000, enabled: true });
    const w = tm.add({ kind: 'web', from: a.id, to: '10.0.0.2', everyMs: 4000, enabled: true });
    const v = tm.add({ kind: 'voip', from: a.id, to: '10.0.0.2', everyMs: 10_000, enabled: true });
    const bad = tm.add({ kind: 'web', from: a.id, to: '10.0.0.99', everyMs: 4000, enabled: true });
    net.engine.advance(30_000);
    expect(tm.stats.get(p.id)!.ok).toBeGreaterThan(5);
    expect(tm.stats.get(w.id)!.ok).toBeGreaterThan(3);
    expect(tm.stats.get(v.id)!.ok).toBeGreaterThan(0);
    expect(tm.stats.get(bad.id)!.fail).toBeGreaterThan(0);
    expect(tm.stats.get(bad.id)!.ok).toBe(0);
  });
});
