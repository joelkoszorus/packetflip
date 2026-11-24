import { describe, expect, it } from 'vitest';
import { GameStore, BOARD } from '../src/game/store';
import { ping, type Host } from '../src/sim';
import { ip } from './helpers';

function linkSnapshot(s: GameStore) {
  return [...s.net.links.values()].map((l) => `${l.id}:${l.a.device}/${l.a.port}-${l.b.device}/${l.b.port}:${l.up}`).sort();
}

function origins(s: GameStore) {
  const m = new Map<string, { x: number; z: number }>();
  for (const id of s.group) m.set(id, { ...s.net.device(id)!.position });
  return m;
}

describe('group selection and moving', () => {
  it('moves a group together without touching any cable', () => {
    const s = new GameStore();
    s.newSandbox(true);
    const names = ['PC1', 'Laptop1', 'SW1'];
    const ids = names.map((n) => s.net.deviceByName(n)!.id);
    s.setGroup(ids, ids[0]);
    expect(s.group.size).toBe(3);
    const before = linkSnapshot(s);
    const start = origins(s);

    s.moveGroup(start, 6, -3);
    for (const [id, o] of start) expect(s.net.device(id)!.position).toEqual({ x: o.x + 6, z: o.z - 3 });
    // Devices outside the group stay put.
    expect(s.net.deviceByName('EDGE')!.position).toEqual({ x: 0, z: -5 });
    expect(linkSnapshot(s)).toEqual(before);

    // Traffic still flows across the moved switch afterwards.
    const pc = s.net.deviceByName<Host>('PC1')!;
    const session = ping(pc, ip('192.168.1.20'), { count: 2 });
    s.net.engine.runUntilIdle(60_000);
    expect(session.results.filter((r) => r.kind === 'reply')).toHaveLength(2);
  });

  it('keeps the group shape when it hits the edge of the board', () => {
    const s = new GameStore();
    s.newSandbox(true);
    s.selectAll();
    const start = origins(s);
    s.moveGroup(start, 10_000, -10_000);
    const xs = [...s.group].map((id) => s.net.device(id)!.position.x);
    const zs = [...s.group].map((id) => s.net.device(id)!.position.z);
    expect(Math.max(...xs)).toBe(BOARD);
    expect(Math.min(...zs)).toBe(-BOARD);
    // Relative spacing is preserved.
    const [a, b] = [...start.keys()];
    expect(s.net.device(a!)!.position.x - s.net.device(b!)!.position.x).toBe(start.get(a!)!.x - start.get(b!)!.x);
  });

  it('toggles membership and clears with select(null)', () => {
    const s = new GameStore();
    s.newSandbox(true);
    const a = s.net.deviceByName('PC1')!.id;
    const b = s.net.deviceByName('SW1')!.id;
    s.select(a);
    s.toggleInGroup(b);
    expect([...s.group].sort()).toEqual([a, b].sort());
    s.toggleInGroup(a);
    expect([...s.group]).toEqual([b]);
    s.select(null);
    expect(s.group.size).toBe(0);
    expect(s.selected).toBeNull();
  });

  it('group delete removes owned devices but never scenario customer devices', () => {
    const s = new GameStore();
    s.startScenario('first-day');
    const bought = s.placeDevice('switch', 0, 0)!;
    s.selectAll();
    expect(s.group.size).toBe(4);
    expect(s.deleteGroup()).toBe(1);
    expect(s.net.device(bought)).toBeUndefined();
    expect(s.net.devices.size).toBe(3);
    expect(s.group.size).toBe(3);
  });
});
