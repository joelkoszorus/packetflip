import { describe, expect, it } from 'vitest';
import { Network, type Router, type Switch, type Host } from '../src/sim';
import { Shell, resolvePortName } from '../src/cli/shell';
import { runningConfig } from '../src/cli/show';
import { cable, host, replies, runPing } from './helpers';

function shell(d: Router | Switch | Host) {
  const out: string[] = [];
  const sh = new Shell(d, (lines) => out.push(...lines));
  const run = (...lines: string[]) => {
    for (const l of lines) sh.execute(l);
    return out;
  };
  return { sh, out, run };
}

describe('NetOS parser', () => {
  it('accepts abbreviations and reports ambiguity / bad input', () => {
    const net = new Network();
    const r = net.addDevice<Router>('router', { name: 'R1' });
    const { sh, out, run } = shell(r);
    run('en');
    expect(sh.prompt()).toBe('R1#');
    run('sh ip int br');
    expect(out.some((l) => l.startsWith('ge0'))).toBe(true);
    out.length = 0;
    run('c');
    expect(out[0]).toMatch(/Ambiguous|Incomplete/);
    out.length = 0;
    run('conf t', 'interface ge9');
    expect(out.join('\n')).toMatch(/No interface/);
    out.length = 0;
    run('ip route 10.0.0.0 255.0.255.0 1.2.3.4');
    expect(out[0]).toMatch(/Invalid input/);
  });

  it('completes with Tab and lists options with ?', () => {
    const net = new Network();
    const r = net.addDevice<Router>('router', { name: 'R1' });
    const { sh } = shell(r);
    sh.execute('enable');
    expect(sh.complete('conf').line).toBe('configure ');
    expect(sh.help('show ').map((l) => l.trim().split(/\s+/)[0])).toContain('running-config');
  });

  it('resolves short interface names', () => {
    expect(resolvePortName(['ge0', 'ge1'], 'g1')).toBe('ge1');
    expect(resolvePortName(['port1', 'port10'], 'p1')).toBe('port1');
    expect(resolvePortName(['inside', 'outside'], 'out')).toBe('outside');
    expect(resolvePortName(['port1', 'port10'], 'p')).toBeNull();
    expect(resolvePortName(['ge0', 'ge1'], 'x0')).toBeNull();
    expect(resolvePortName(['inside', 'outside'], 'outside')).toBe('outside');
  });

  it('strips control characters and caps line length', () => {
    const net = new Network();
    const r = net.addDevice<Router>('router', { name: 'R1' });
    const { sh, out } = shell(r);
    sh.execute('\u001b[31menable\u0007');
    expect(sh.prompt()).toBe('R1#');
    sh.execute('show ' + 'x'.repeat(100_000));
    expect(out.at(-1)).toMatch(/Invalid input/);
  });
});

describe('NetOS configures the same state as the GUI', () => {
  it('builds router-on-a-stick from the CLI and pings across VLANs', () => {
    const net = new Network();
    const s = net.addDevice<Switch>('switch', { name: 'SW1' });
    const r = net.addDevice<Router>('router', { name: 'R1' });
    const a = host(net, 'A', '10.0.10.5', 24, '10.0.10.1');
    const b = host(net, 'B', '10.0.20.5', 24, '10.0.20.1');
    cable(net, a, 0, s, 0);
    cable(net, b, 0, s, 1);
    cable(net, s, 7, r, 0);
    const sw = shell(s);
    sw.run(
      'enable',
      'configure terminal',
      'vlan 10',
      'name staff',
      'vlan 20',
      'name guest',
      'interface p1',
      'switchport mode access',
      'switchport access vlan 10',
      'int port2',
      'sw acc vlan 20',
      'interface port8',
      'switchport mode trunk',
      'switchport trunk allowed vlan 10,20',
      'end',
    );
    expect(sw.out.filter((l) => l.startsWith('%'))).toEqual([]);
    const rt = shell(r);
    rt.run('en', 'conf t', 'interface ge0.10', 'ip address 10.0.10.1 255.255.255.0', 'interface ge0.20', 'ip address 10.0.20.1 /24', 'end');
    expect(replies(runPing(a, '10.0.20.5', 2))).toBe(2);

    // ACL from the CLI blocks guest → staff but still allows guest → router.
    rt.run(
      'conf t',
      'ip access-list extended GUEST-IN',
      'deny ip 10.0.20.0/24 10.0.10.0/24',
      'permit ip any any',
      'interface ge0.20',
      'ip access-group GUEST-IN in',
      'end',
    );
    a.clearDynamicState();
    b.clearDynamicState();
    expect(replies(runPing(b, '10.0.10.5', 1))).toBe(0);
    expect(replies(runPing(b, '10.0.20.1', 1))).toBe(1);
    rt.out.length = 0;
    rt.run('show access-lists');
    expect(rt.out.join('\n')).toMatch(/deny ip 10\.0\.20\.0\/24 10\.0\.10\.0\/24 \(\d+ matches\)/);
  });

  it('running-config round-trips onto a fresh router', () => {
    const net = new Network();
    const r = net.addDevice<Router>('router', { name: 'EDGE' });
    shell(r).run(
      'en',
      'conf t',
      'interface ge0',
      'description LAN side',
      'ip address 192.168.1.1 255.255.255.0',
      'ip nat inside',
      'ip helper-address 192.168.1.2',
      'interface ge1',
      'ip address 203.0.113.2 255.255.255.248',
      'ip nat outside',
      'interface ge2',
      'shutdown',
      'interface ge0.30',
      'ip address 10.30.0.1 /24',
      'exit',
      'ip route 0.0.0.0 0.0.0.0 203.0.113.1',
      'ip access-list extended WEB',
      'permit tcp any host 192.168.1.80 eq 80',
      'deny icmp any any',
      'ip dhcp excluded-address 192.168.1.1 192.168.1.9',
      'ip dhcp pool LAN',
      'network 192.168.1.0 255.255.255.0',
      'range 192.168.1.100 192.168.1.150',
      'default-router 192.168.1.1',
      'dns-server 192.168.1.2',
      'ip nat enable',
      'ip nat forward tcp 80 192.168.1.80 80',
      'end',
    );
    const cfg = runningConfig(r);

    const fresh = net.addDevice<Router>('router', { name: 'COPY' });
    const f = shell(fresh);
    f.run('enable', 'configure terminal', ...cfg.filter((l) => l !== '!' && l !== 'end'), 'end');
    expect(f.out.filter((l) => l.startsWith('%'))).toEqual([]);
    expect(runningConfig(fresh)).toEqual(cfg);
    expect(fresh.serializeConfig()).toEqual(r.serializeConfig());
  });

  it('switch running-config round-trips', () => {
    const net = new Network();
    const s = net.addDevice<Switch>('switch', { name: 'SW1' });
    shell(s).run(
      'en',
      'conf t',
      'vlan 10',
      'name staff',
      'vlan 99',
      'name mgmt',
      'int port3',
      'sw mode acc',
      'sw acc vlan 10',
      'description Reception',
      'int port8',
      'sw mode trunk',
      'sw trunk allowed vlan 1,10,99',
      'sw trunk native vlan 99',
      'int port5',
      'shutdown',
      'end',
    );
    const cfg = runningConfig(s);
    const t = net.addDevice<Switch>('switch', { name: 'SW2' });
    const sh2 = shell(t);
    sh2.run('en', 'conf t', ...cfg.filter((l) => l !== '!' && l !== 'end'), 'end');
    expect(sh2.out.filter((l) => l.startsWith('%'))).toEqual([]);
    expect(t.serializeConfig()).toEqual(s.serializeConfig());
  });

  it('host commands: ipconfig /static, ping by name, nslookup', () => {
    const net = new Network();
    const s = net.addDevice<Switch>('switch');
    const srv = host(net, 'SRV', '10.0.0.2');
    srv.dnsServer.enabled = true;
    srv.dnsServer.setRecord('files.office.test', srv.nic.ip!);
    const pc = host(net, 'PC');
    cable(net, srv, 0, s, 0);
    cable(net, pc, 0, s, 1);
    const { sh, out, run } = shell(pc);
    expect(sh.prompt()).toBe('PC:~$');
    run('ipconfig /static 10.0.0.10 255.255.255.0', 'ipconfig /dns 10.0.0.2', 'ping files.office.test 2');
    net.engine.runUntilIdle(60_000);
    expect(out.join('\n')).toMatch(/2 sent, 2 received, 0% loss/);
    out.length = 0;
    run('nslookup missing.office.test');
    net.engine.runUntilIdle(60_000);
    expect(out.join('\n')).toMatch(/NXDOMAIN/);
  });
});
