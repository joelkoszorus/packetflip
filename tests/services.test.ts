import { describe, expect, it } from 'vitest';
import { Network, Cloud, Firewall, INTERNET, formatIp, parseWebTarget, type AppResult, type Host } from '../src/sim';
import { cable, collect, host, ip, replies, router, runPing, setIf, sw } from './helpers';

function run(net: Network, ms = 120_000) {
  net.engine.runUntilIdle(ms);
}

function browse(net: Network, h: Host, target: string): AppResult {
  let result: AppResult = { ok: false, message: 'never finished' };
  h.browse(target, (r) => (result = r));
  run(net);
  return result;
}

describe('DHCP', () => {
  function lan() {
    const net = new Network();
    const s = sw(net);
    const srv = host(net, 'SRV', '192.168.1.2', 24, '192.168.1.1');
    srv.dhcpServer.enabled = true;
    srv.dhcpServer.pools.push({
      name: 'LAN',
      network: ip('192.168.1.0'),
      prefix: 24,
      start: ip('192.168.1.100'),
      end: ip('192.168.1.102'),
      gateway: ip('192.168.1.1'),
      dns: ip('192.168.1.2'),
    });
    cable(net, srv, 0, s, 0);
    return { net, s, srv };
  }

  it('leases an address, gateway and DNS server (DORA)', () => {
    const { net, s } = lan();
    const c = host(net, 'C');
    cable(net, c, 0, s, 1);
    let ok: boolean | undefined;
    c.useDhcp((r) => (ok = r));
    run(net);
    expect(ok).toBe(true);
    expect(formatIp(c.nic.ip!)).toBe('192.168.1.100');
    expect(formatIp(c.gateway!)).toBe('192.168.1.1');
    expect(formatIp(c.dns!)).toBe('192.168.1.2');
    expect(replies(runPing(c, '192.168.1.2', 1))).toBe(1);
  });

  it('hands out distinct addresses and respects the pool size', () => {
    const { net, s } = lan();
    const clients = [1, 2, 3, 4].map((i) => {
      const c = host(net, `C${i}`);
      cable(net, c, 0, s, i);
      return c;
    });
    for (const c of clients) c.useDhcp();
    run(net, 200_000);
    const leased = clients.filter((c) => c.nic.dhcp && c.dhcpClient.phase === 'bound').map((c) => c.nic.ip);
    expect(new Set(leased).size).toBe(3);
    // The 4th client finds the pool exhausted and falls back to APIPA.
    const apipa = clients.find((c) => c.dhcpClient.phase === 'failed');
    expect(apipa && formatIp(apipa.nic.ip!).startsWith('169.254.')).toBe(true);
  });

  it('works across a router with a DHCP relay (ip helper-address)', () => {
    const { net, s, srv } = lan();
    srv.dhcpServer.pools.push({
      name: 'FLOOR2',
      network: ip('10.2.0.0'),
      prefix: 24,
      start: ip('10.2.0.50'),
      end: ip('10.2.0.60'),
      gateway: ip('10.2.0.1'),
      dns: ip('192.168.1.2'),
    });
    const r = router(net);
    setIf(r, 'ge0', '192.168.1.1');
    setIf(r, 'ge1', '10.2.0.1');
    cable(net, s, 7, r, 0);
    const s2 = sw(net, 'SW2');
    cable(net, r, 1, s2, 7);
    const c = host(net, 'C');
    cable(net, c, 0, s2, 0);

    c.useDhcp();
    run(net, 60_000);
    expect(c.dhcpClient.phase).toBe('failed'); // no relay yet → APIPA

    r.ifaceByName('ge1')!.helper = ip('192.168.1.2');
    let ok = false;
    c.useDhcp((v) => (ok = v));
    run(net);
    expect(ok).toBe(true);
    expect(formatIp(c.nic.ip!)).toBe('10.2.0.50');
    expect(replies(runPing(c, '192.168.1.2', 1))).toBe(1);
  });

  it('a router can be the DHCP server itself', () => {
    const net = new Network();
    const r = router(net);
    setIf(r, 'ge0', '10.9.0.1');
    r.dhcp.enabled = true;
    r.dhcp.pools.push({ name: 'P', network: ip('10.9.0.0'), prefix: 24, start: ip('10.9.0.10'), end: ip('10.9.0.20'), gateway: ip('10.9.0.1'), dns: null });
    const c = host(net, 'C');
    cable(net, c, 0, r, 0);
    c.useDhcp();
    run(net);
    expect(formatIp(c.nic.ip!)).toBe('10.9.0.10');
  });
});

describe('parseWebTarget', () => {
  it('normalises what players type into a browser', () => {
    expect(parseWebTarget('10.0.10.20')).toEqual({ host: '10.0.10.20', port: 80, path: '/' });
    expect(parseWebTarget(' http://10.0.10.20 ')).toEqual({ host: '10.0.10.20', port: 80, path: '/' });
    expect(parseWebTarget('Http://WWW.PacketFlip.test./a/b')).toEqual({ host: 'www.packetflip.test', port: 80, path: '/a/b' });
    expect(parseWebTarget('shop.test:8080?q=1')).toEqual({ host: 'shop.test', port: 8080, path: '/?q=1' });
    expect(parseWebTarget('http://host:0')).toMatch(/Port/);
    expect(parseWebTarget('')).toMatch(/Enter a web address/);
    expect(parseWebTarget('http://<b>x</b>')).toMatch(/not a valid/);
    expect(parseWebTarget('x'.repeat(500))).toMatch(/too long/);
  });
});

describe('DNS and HTTP', () => {
  function office() {
    const net = new Network();
    const s = sw(net);
    const srv = host(net, 'SRV', '10.0.0.2');
    srv.dnsServer.enabled = true;
    srv.dnsServer.setRecord('intranet.office.test', ip('10.0.0.2'));
    srv.http.enabled = true;
    srv.http.title = 'Office intranet';
    const c = host(net, 'C', '10.0.0.10');
    c.dns = ip('10.0.0.2');
    cable(net, srv, 0, s, 0);
    cable(net, c, 0, s, 1);
    return { net, srv, c };
  }

  it('resolves names and browses by name', () => {
    const { net, c } = office();
    const r = browse(net, c, 'intranet.office.test');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Office intranet');
  });

  it('browses typed URLs: http:// prefix, port and path', () => {
    const { net, c } = office();
    expect(browse(net, c, 'http://10.0.0.2').ok).toBe(true);
    expect(browse(net, c, 'HTTP://intranet.office.test/payroll?x=1').ok).toBe(true);
    expect(browse(net, c, 'http://10.0.0.2:80/').ok).toBe(true);
    expect(browse(net, c, 'http://10.0.0.2:8080').message).toMatch(/refused.*8080/);
    expect(browse(net, c, 'https://10.0.0.2').message).toMatch(/HTTPS/);
    expect(browse(net, c, 'ftp://10.0.0.2').message).toMatch(/Only web addresses/);
  });

  it('reports NXDOMAIN, missing DNS, refused connections and bad input', () => {
    const { net, c, srv } = office();
    expect(browse(net, c, 'nope.office.test').message).toMatch(/NXDOMAIN/);
    srv.http.enabled = false;
    expect(browse(net, c, '10.0.0.2').message).toMatch(/refused/);
    c.dns = null;
    expect(browse(net, c, 'intranet.office.test').message).toMatch(/No DNS/);
    expect(browse(net, c, '<script>alert(1)</script>').ok).toBe(false);
  });
});

describe('ACLs', () => {
  it('blocks HTTP but permits ping with an extended ACL', () => {
    const net = new Network();
    const r = router(net);
    setIf(r, 'ge0', '10.1.0.1');
    setIf(r, 'ge1', '10.2.0.1');
    const c = host(net, 'C', '10.1.0.10', 24, '10.1.0.1');
    const srv = host(net, 'SRV', '10.2.0.10', 24, '10.2.0.1');
    srv.http.enabled = true;
    cable(net, c, 0, r, 0);
    cable(net, srv, 0, r, 1);
    expect(browse(net, c, '10.2.0.10').ok).toBe(true);

    r.addAclEntry('NO-WEB', { action: 'deny', proto: 'tcp', src: { any: true }, dst: { net: ip('10.2.0.10'), prefix: 32 }, dstPort: 80 });
    r.addAclEntry('NO-WEB', { action: 'permit', proto: 'ip', src: { any: true }, dst: { any: true } });
    r.ifaceByName('ge0')!.aclIn = 'NO-WEB';
    const events = collect(net);
    const blocked = browse(net, c, '10.2.0.10');
    expect(blocked.ok).toBe(false);
    expect(events.some((e) => e.type === 'drop' && e.reason === 'acl-deny')).toBe(true);
    expect(replies(runPing(c, '10.2.0.10', 1))).toBe(1);
    expect(r.aclHits.get('NO-WEB')?.[0]).toBeGreaterThan(0);
  });

  it('has an implicit deny at the end', () => {
    const net = new Network();
    const r = router(net);
    setIf(r, 'ge0', '10.1.0.1');
    setIf(r, 'ge1', '10.2.0.1');
    const c = host(net, 'C', '10.1.0.10', 24, '10.1.0.1');
    const d = host(net, 'D', '10.2.0.10', 24, '10.2.0.1');
    cable(net, c, 0, r, 0);
    cable(net, d, 0, r, 1);
    r.addAclEntry('ONLY-WEB', { action: 'permit', proto: 'tcp', src: { any: true }, dst: { any: true }, dstPort: 80 });
    r.ifaceByName('ge0')!.aclIn = 'ONLY-WEB';
    expect(replies(runPing(c, '10.2.0.10', 1))).toBe(0);
  });
});

describe('Internet edge: NAT, port forwarding, firewall', () => {
  function edge(withFirewall = false) {
    const net = new Network();
    const isp = net.addDevice<Cloud>('cloud', { name: 'ISP' });
    const r = router(net, 'EDGE');
    setIf(r, 'ge0', '192.168.1.1');
    setIf(r, 'ge1', '203.0.113.2', 29);
    r.addStaticRoute({ net: 0, prefix: 0, nextHop: ip('203.0.113.1') });
    const s = sw(net);
    const pc = host(net, 'PC', '192.168.1.10', 24, '192.168.1.1');
    pc.dns = INTERNET.dns;
    const web = host(net, 'WEB', '192.168.1.80', 24, '192.168.1.1');
    web.http.enabled = true;
    web.http.title = 'Our shop';
    cable(net, pc, 0, s, 0);
    cable(net, web, 0, s, 1);
    let fw: Firewall | undefined;
    if (withFirewall) {
      fw = net.addDevice<Firewall>('firewall', { name: 'FW' });
      // LAN switch → FW inside; FW outside → router
      setIf(fw, 'inside', '192.168.1.1');
      setIf(fw, 'outside', '10.255.0.2', 30);
      fw.addStaticRoute({ net: 0, prefix: 0, nextHop: ip('10.255.0.1') });
      setIf(r, 'ge0', '10.255.0.1', 30);
      r.addStaticRoute({ net: ip('192.168.1.0'), prefix: 24, nextHop: ip('10.255.0.2') });
      cable(net, s, 7, fw, 0);
      cable(net, fw, 1, r, 0);
    } else {
      cable(net, s, 7, r, 0);
    }
    cable(net, r, 1, isp, 0);
    return { net, isp, r, pc, web, fw };
  }

  it('without NAT the ISP drops private sources', () => {
    const { net, pc } = edge();
    const events = collect(net);
    expect(replies(runPing(pc, '192.0.2.80', 1))).toBe(0);
    expect(events.some((e) => e.type === 'drop' && e.reason === 'bogon-source')).toBe(true);
  });

  it('with PAT, inside hosts can ping and browse the Internet by name', () => {
    const { net, r, pc } = edge();
    r.nat.enabled = true;
    r.ifaceByName('ge0')!.nat = 'inside';
    r.ifaceByName('ge1')!.nat = 'outside';
    expect(replies(runPing(pc, '192.0.2.80', 2))).toBe(2);
    const res = browse(net, pc, 'www.packetflip.test');
    expect(res.ok).toBe(true);
    expect(res.message).toContain('Welcome to the Internet');
    expect(r.nat.translations().length).toBeGreaterThan(0);
  });

  it('a port forward publishes an inside web server; other ports stay closed', () => {
    const { net, r, isp, web } = edge();
    r.nat.enabled = true;
    r.ifaceByName('ge0')!.nat = 'inside';
    r.ifaceByName('ge1')!.nat = 'outside';
    let visit: AppResult | undefined;
    isp.visit(ip('203.0.113.2'), (v) => (visit = v));
    run(net);
    expect(visit?.ok).toBe(false);

    r.nat.forwards.push({ proto: 'tcp', outsidePort: 80, insideIp: web.nic.ip!, insidePort: 80 });
    isp.visit(ip('203.0.113.2'), (v) => (visit = v));
    run(net);
    expect(visit?.ok).toBe(true);
    expect(visit?.message).toContain('Our shop');
  });

  it('attacks on a routed (un-NATed) host are breaches until a firewall blocks them', () => {
    const { net, r, isp, pc, fw } = edge(true);
    // Give the ISP a route to the LAN so it is publicly routed (no NAT) for this test.
    isp.staticRoutes.push({ net: ip('192.168.1.0'), prefix: 24, nextHop: ip('203.0.113.2') });
    void r;
    const events = collect(net);
    // Remove the firewall's protection by allowing everything inbound, then attack.
    fw!.addRule({ from: 'outside', to: 'inside', proto: 'ip', dst: { any: true } });
    isp.attack(pc.nic.ip!, [22, 3389]);
    run(net);
    const breaches = () => events.filter((e) => e.type === 'breach').length;
    expect(breaches()).toBe(2);

    // Default stateful policy: deny unsolicited inbound, allow only web to the server.
    fw!.rules = [{ from: 'outside', to: 'inside', proto: 'tcp', dst: { net: ip('192.168.1.80'), prefix: 32 }, dstPort: 80 }];
    events.length = 0;
    isp.attack(pc.nic.ip!, [22, 3389, 445]);
    run(net);
    expect(breaches()).toBe(0);
    expect(events.filter((e) => e.type === 'drop' && e.reason === 'firewall-deny').length).toBe(3);

    // Legit inbound web to the server is allowed; inside-initiated browsing still works.
    let visit: AppResult | undefined;
    isp.visit(ip('192.168.1.80'), (v) => (visit = v));
    run(net);
    expect(visit?.ok).toBe(true);
    // Inside → Internet works via state tracking (ISP routes back to LAN in this test).
    expect(replies(runPing(pc, '192.0.2.80', 1))).toBe(1);
  });
});
