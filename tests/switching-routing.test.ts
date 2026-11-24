import { describe, expect, it } from 'vitest';
import { Network } from '../src/sim/network';
import { ping } from '../src/sim/diag/ping';
import { cable, collect, host, ip, replies, router, runPing, runTrace, setIf, sw } from './helpers';

describe('same-subnet switching', () => {
  it('pings across a switch after ARP resolution, and learns MACs', () => {
    const net = new Network();
    const s = sw(net);
    const a = host(net, 'A', '192.168.1.10');
    const b = host(net, 'B', '192.168.1.11');
    cable(net, a, 0, s, 0);
    cable(net, b, 0, s, 1);
    const events = collect(net);

    const res = runPing(a, '192.168.1.11', 3);
    expect(res.done).toBe(true);
    expect(replies(res)).toBe(3);
    expect(a.arpCache.size).toBe(1);
    expect(s.macEntries().map((e) => e.port).sort()).toEqual(['port1', 'port2']);
    expect(events.some((e) => e.type === 'hop' && e.frame.etherType === 'arp')).toBe(true);
  });

  it('reports host unreachable when the target does not exist', () => {
    const net = new Network();
    const s = sw(net);
    const a = host(net, 'A', '192.168.1.10');
    cable(net, a, 0, s, 0);
    const res = runPing(a, '192.168.1.99', 2);
    expect(replies(res)).toBe(0);
    expect(res.results.every((r) => r.kind === 'local-failure')).toBe(true);
  });

  it('fails without a cable, with a clear reason', () => {
    const net = new Network();
    const a = host(net, 'A', '192.168.1.10');
    const res = runPing(a, '192.168.1.11', 1);
    expect(res.results[0]?.kind).toBe('local-failure');
    expect(res.results[0]?.reason).toMatch(/plugged|down/i);
  });

  it('explains a missing default gateway', () => {
    const net = new Network();
    const s = sw(net);
    const a = host(net, 'A', '192.168.1.10');
    cable(net, a, 0, s, 0);
    const res = runPing(a, '10.0.0.1', 1);
    expect(res.results[0]?.reason).toMatch(/gateway/i);
  });

  it('pings its own address via loopback', () => {
    const net = new Network();
    const a = host(net, 'A', '192.168.1.10');
    expect(replies(runPing(a, '192.168.1.10', 1))).toBe(1);
  });
});

describe('routing', () => {
  function twoSubnets() {
    const net = new Network();
    const r = router(net);
    const s1 = sw(net, 'SW1');
    const s2 = sw(net, 'SW2');
    const a = host(net, 'A', '192.168.1.10', 24, '192.168.1.1');
    const b = host(net, 'B', '192.168.2.10', 24, '192.168.2.1');
    setIf(r, 'ge0', '192.168.1.1');
    setIf(r, 'ge1', '192.168.2.1');
    cable(net, a, 0, s1, 0);
    cable(net, s1, 1, r, 0);
    cable(net, r, 1, s2, 1);
    cable(net, b, 0, s2, 0);
    return { net, r, a, b, s1, s2 };
  }

  it('routes between two connected subnets', () => {
    const { a, b } = twoSubnets();
    expect(replies(runPing(a, '192.168.2.10', 3))).toBe(3);
    expect(replies(runPing(b, '192.168.1.10', 1))).toBe(1);
  });

  it('decrements TTL at each router', () => {
    const { a } = twoSubnets();
    const res = runPing(a, '192.168.2.10', 1);
    expect(res.results[0]?.ttl).toBe(63);
  });

  it('fails when the far host has the wrong gateway', () => {
    const { a, b } = twoSubnets();
    b.gateway = ip('192.168.2.254');
    expect(replies(runPing(a, '192.168.2.10', 2))).toBe(0);
  });

  it('uses static routes across a chain of routers and traceroute shows each hop', () => {
    const net = new Network();
    const r1 = router(net, 'R1');
    const r2 = router(net, 'R2');
    const a = host(net, 'A', '10.1.0.10', 24, '10.1.0.1');
    const b = host(net, 'B', '10.2.0.10', 24, '10.2.0.1');
    setIf(r1, 'ge0', '10.1.0.1');
    setIf(r1, 'ge1', '172.16.0.1', 30);
    setIf(r2, 'ge1', '172.16.0.2', 30);
    setIf(r2, 'ge0', '10.2.0.1');
    cable(net, a, 0, r1, 0);
    cable(net, r1, 1, r2, 1);
    cable(net, r2, 0, b, 0);

    // Without routes, R1 answers "network unreachable".
    const before = runPing(a, '10.2.0.10', 1);
    expect(before.results[0]?.kind).toBe('unreachable');

    r1.addStaticRoute({ net: ip('10.2.0.0'), prefix: 24, nextHop: ip('172.16.0.2') });
    r2.addStaticRoute({ net: ip('0.0.0.0'), prefix: 0, nextHop: ip('172.16.0.1') });
    expect(replies(runPing(a, '10.2.0.10', 2))).toBe(2);

    const trace = runTrace(a, '10.2.0.10');
    expect(trace.done).toBe(true);
    expect(trace.results.map((r) => r.kind)).toEqual(['ttl-exceeded', 'ttl-exceeded', 'reply']);
  });

  it('survives a routing loop: TTL expires instead of hanging', () => {
    const net = new Network();
    const r1 = router(net, 'R1');
    const r2 = router(net, 'R2');
    const a = host(net, 'A', '10.1.0.10', 24, '10.1.0.1');
    setIf(r1, 'ge0', '10.1.0.1');
    setIf(r1, 'ge1', '172.16.0.1', 30);
    setIf(r2, 'ge1', '172.16.0.2', 30);
    cable(net, a, 0, r1, 0);
    cable(net, r1, 1, r2, 1);
    r1.addStaticRoute({ net: 0, prefix: 0, nextHop: ip('172.16.0.2') });
    r2.addStaticRoute({ net: 0, prefix: 0, nextHop: ip('172.16.0.1') });
    const events = collect(net);
    const res = ping(a, ip('8.8.8.8'), { count: 1, ttl: 12, timeoutMs: 20_000 });
    net.engine.runUntilIdle(60_000);
    expect(res.results[0]?.kind).toBe('ttl-exceeded');
    expect(events.some((e) => e.type === 'drop' && e.reason === 'ttl-expired')).toBe(true);
  });
});

describe('VLANs and trunks', () => {
  it('isolates hosts in different VLANs on the same switch', () => {
    const net = new Network();
    const s = sw(net);
    s.vlans.set(10, 'staff');
    s.vlans.set(20, 'guest');
    const a = host(net, 'A', '192.168.1.10');
    const b = host(net, 'B', '192.168.1.11');
    cable(net, a, 0, s, 0);
    cable(net, b, 0, s, 1);
    s.portConfig[0]!.accessVlan = 10;
    s.portConfig[1]!.accessVlan = 20;
    expect(replies(runPing(a, '192.168.1.11', 1))).toBe(0);
    s.portConfig[1]!.accessVlan = 10;
    a.clearDynamicState();
    expect(replies(runPing(a, '192.168.1.11', 1))).toBe(1);
  });

  it('drops frames for a VLAN that was never created', () => {
    const net = new Network();
    const s = sw(net);
    const a = host(net, 'A', '192.168.1.10');
    cable(net, a, 0, s, 0);
    s.portConfig[0]!.accessVlan = 30;
    const events = collect(net);
    runPing(a, '192.168.1.11', 1);
    expect(events.some((e) => e.type === 'drop' && e.reason === 'vlan-missing')).toBe(true);
  });

  it('routes between VLANs with router-on-a-stick over a trunk', () => {
    const net = new Network();
    const s = sw(net);
    const r = router(net);
    s.vlans.set(10, 'staff');
    s.vlans.set(20, 'guest');
    const a = host(net, 'A', '10.0.10.5', 24, '10.0.10.1');
    const b = host(net, 'B', '10.0.20.5', 24, '10.0.20.1');
    cable(net, a, 0, s, 0);
    cable(net, b, 0, s, 1);
    cable(net, s, 7, r, 0);
    s.portConfig[0]!.accessVlan = 10;
    s.portConfig[1]!.accessVlan = 20;
    s.portConfig[7]!.mode = 'trunk';
    const v10 = r.addSubinterface(0, 10)!;
    const v20 = r.addSubinterface(0, 20)!;
    v10.ip = ip('10.0.10.1');
    v20.ip = ip('10.0.20.1');
    const events = collect(net);
    expect(replies(runPing(a, '10.0.20.5', 2))).toBe(2);
    // Frames on the trunk are tagged.
    const trunkHops = events.filter((e) => e.type === 'hop' && e.link === r.ports[0]!.link!.id);
    expect(trunkHops.length).toBeGreaterThan(0);
    expect(trunkHops.every((e) => e.type === 'hop' && (e.frame.vlan === 10 || e.frame.vlan === 20))).toBe(true);
  });

  it('a trunk that prunes a VLAN blocks it', () => {
    const net = new Network();
    const s1 = sw(net, 'SW1');
    const s2 = sw(net, 'SW2');
    for (const s of [s1, s2]) s.vlans.set(10, 'staff');
    const a = host(net, 'A', '10.0.10.5');
    const b = host(net, 'B', '10.0.10.6');
    cable(net, a, 0, s1, 0);
    cable(net, b, 0, s2, 0);
    cable(net, s1, 7, s2, 7);
    for (const s of [s1, s2]) {
      s.portConfig[0]!.accessVlan = 10;
      s.portConfig[7]!.mode = 'trunk';
    }
    expect(replies(runPing(a, '10.0.10.6', 1))).toBe(1);
    s1.portConfig[7]!.allowedVlans = [1];
    a.clearDynamicState();
    b.clearDynamicState();
    expect(replies(runPing(a, '10.0.10.6', 1))).toBe(0);
  });
});

describe('safety limits', () => {
  it('a switching loop is cut off by the l2 hop cap instead of hanging', () => {
    const net = new Network();
    const s1 = sw(net, 'SW1');
    const s2 = sw(net, 'SW2');
    cable(net, s1, 6, s2, 6);
    cable(net, s1, 7, s2, 7);
    const a = host(net, 'A', '10.0.0.1');
    cable(net, a, 0, s1, 0);
    const events = collect(net);
    runPing(a, '10.0.0.2', 1);
    expect(events.some((e) => e.type === 'drop' && e.reason === 'l2-loop')).toBe(true);
    expect(net.engine.pending).toBe(0);
  });

  it('rejects invalid cabling', () => {
    const net = new Network();
    const s = sw(net);
    const a = host(net, 'A');
    const b = host(net, 'B');
    cable(net, a, 0, s, 0);
    expect(() => cable(net, b, 0, s, 0)).toThrow(/in use/);
    expect(() => cable(net, s, 1, s, 2)).toThrow(/itself/);
    expect(() => cable(net, b, 5, s, 2)).toThrow(/port/);
  });

  it('cutting a cable stops traffic', () => {
    const net = new Network();
    const s = sw(net);
    const a = host(net, 'A', '192.168.1.10');
    const b = host(net, 'B', '192.168.1.11');
    cable(net, a, 0, s, 0);
    const l = cable(net, b, 0, s, 1);
    expect(replies(runPing(a, '192.168.1.11', 1))).toBe(1);
    l.up = false;
    expect(replies(runPing(a, '192.168.1.11', 1))).toBe(0);
  });
});
