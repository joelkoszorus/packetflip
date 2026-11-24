import { describe, expect, it } from 'vitest';
import { Network, type Router, type Switch, TrafficManager, createRng } from '../src/sim';
import { buildNetwork, serializeNetwork } from '../src/persistence/serialize';
import { ValidationError, parseSave, safeJsonParse, validateSave } from '../src/persistence/validate';
import { decodeShare, encodeShare, shareFromHash } from '../src/persistence/share';
import { cable, host, ip, replies, runPing, setIf } from './helpers';

function sample() {
  const net = new Network();
  const s = net.addDevice<Switch>('switch', { name: 'SW1', position: { x: 2, z: 3 } });
  const r = net.addDevice<Router>('router', { name: 'R1' });
  s.vlans.set(10, 'staff');
  s.portConfig[0]!.accessVlan = 10;
  s.portConfig[7]!.mode = 'trunk';
  const sub = r.addSubinterface(0, 10)!;
  sub.ip = ip('10.0.10.1');
  setIf(r, 'ge1', '192.168.5.1');
  r.addAclEntry('X', { action: 'deny', proto: 'tcp', src: { any: true }, dst: { net: ip('10.0.10.5'), prefix: 32 }, dstPort: 22 });
  r.nat.enabled = true;
  r.dhcp.pools.push({ name: 'P', network: ip('10.0.10.0'), prefix: 24, start: ip('10.0.10.100'), end: ip('10.0.10.110'), gateway: ip('10.0.10.1'), dns: null });
  const a = host(net, 'Alice PC', '10.0.10.5', 24, '10.0.10.1');
  a.http.enabled = true;
  cable(net, a, 0, s, 0);
  cable(net, s, 7, r, 0);
  const tm = new TrafficManager(net);
  tm.add({ kind: 'ping', from: a.id, to: '10.0.10.1', everyMs: 3000, enabled: true });
  return { net, tm, a };
}

describe('save / load', () => {
  it('round-trips a network and it still works', () => {
    const { net, tm } = sample();
    const save = serializeNetwork(net, 'Office', tm);
    const text = JSON.stringify(save);
    const loaded = buildNetwork(parseSave(text));
    expect(serializeNetwork(loaded, 'Office')).toEqual({ ...save, flows: [] });
    const alice = loaded.deviceByName('Alice PC') as never;
    expect(replies(runPing(alice, '10.0.10.1', 1))).toBe(1);
    expect(save.flows).toHaveLength(1);
  });

  it('rejects prototype-pollution keys anywhere', () => {
    const { net } = sample();
    const text = JSON.stringify(serializeNetwork(net));
    const evil = text.replace('"format"', '"__proto__":{"polluted":true},"format"');
    expect(() => parseSave(evil)).toThrow(ValidationError);
    expect(() => safeJsonParse('{"a":{"constructor":{"prototype":{"x":1}}}}')).toThrow(/forbidden key/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects oversized input before parsing', () => {
    expect(() => safeJsonParse('[' + '1,'.repeat(400_000) + '1]')).toThrow(/too large/);
  });

  it('rejects bad values with a path', () => {
    const { net } = sample();
    const base = () => JSON.parse(JSON.stringify(serializeNetwork(net)));
    const cases: [string, (s: ReturnType<typeof base>) => void, RegExp][] = [
      ['format', (s) => (s.format = 'other'), /not a Packet Flip/],
      ['newer', (s) => (s.version = 99), /newer version/],
      ['kind', (s) => (s.devices[0].kind = 'toaster'), /kind/],
      ['name html', (s) => (s.devices[0].name = '<img src=x onerror=alert(1)>'), /name/],
      ['ip', (s) => (s.devices[2].config.ip = 2 ** 33), /ip/],
      ['vlan', (s) => (s.devices[0].config.vlans[0].id = 5000), /id/],
      ['port idx', (s) => (s.links[0].a.port = 99), /port/],
      ['dup port', (s) => (s.links[1].a = { ...s.links[0].a }), /two cables|port/],
      ['self link', (s) => (s.links[0].b = { ...s.links[0].a, port: 1 }), /itself|port/],
      ['unknown dev', (s) => (s.links[0].a.device = 'd999'), /unknown device/],
      ['too many', (s) => (s.devices = Array(400).fill(s.devices[0])), /too many/],
      ['nan', (s) => (s.devices[0].x = 'NaN'), /number/],
    ];
    for (const [label, mutate, re] of cases) {
      const s = base();
      mutate(s);
      expect(() => validateSave(s), label).toThrow(re);
    }
  });

  it('fuzz: random mutations either load cleanly or fail with a ValidationError', () => {
    const { net, tm } = sample();
    const good = JSON.stringify(serializeNetwork(net, 'x', tm));
    const rng = createRng(1234);
    const junk = ['null', '-1', '1e309', '"x"', '[]', '{}', 'true', '4294967296', '"__proto__"', '"<script>"'];
    for (let i = 0; i < 400; i++) {
      // Replace a random JSON value-ish token with junk.
      const pos = Math.floor(rng() * good.length);
      const m = /[:,[]\s*("[^"]*"|-?\d+(\.\d+)?|true|false|null)/g;
      m.lastIndex = pos;
      const hit = m.exec(good);
      if (!hit) continue;
      const start = hit.index + hit[0].length - hit[1]!.length;
      const text = good.slice(0, start) + junk[Math.floor(rng() * junk.length)] + good.slice(start + hit[1]!.length);
      try {
        const save = parseSave(text);
        buildNetwork(save); // must not throw for anything the validator accepted
      } catch (err) {
        expect(err, text.slice(Math.max(0, start - 40), start + 40)).toBeInstanceOf(ValidationError);
      }
    }
  });
});

describe('share links', () => {
  it('encodes into a URL-safe fragment and decodes back', async () => {
    const { net, tm } = sample();
    const save = serializeNetwork(net, 'Shared', tm);
    const encoded = await encodeShare(save);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(shareFromHash(`#topo=${encoded}`)).toBe(encoded);
    expect(await decodeShare(encoded)).toEqual(save);
  });

  it('rejects garbage and decompression bombs', async () => {
    await expect(decodeShare('not*base64')).rejects.toThrow();
    await expect(decodeShare('AAAA')).rejects.toThrow();
    // ~4 MB of spaces compresses to a few KB; decoding must stop at the cap.
    const bomb = new TextEncoder().encode(' '.repeat(4 * 1024 * 1024));
    const cs = new Blob([bomb]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(cs).arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const encoded = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await expect(decodeShare(encoded)).rejects.toThrow(/too large|too long/);
  });
});
