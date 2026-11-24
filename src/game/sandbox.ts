/** The starter sandbox: a small office with the Internet attached, ready to tinker with. */
import { parseIp, type Network, type Host, type Router, type TrafficManager } from '../sim';
import { typeInto } from './scenarios';

export function defaultSandbox(net: Network, traffic: TrafficManager): void {
  const add = (kind: Parameters<Network['addDevice']>[0], name: string, x: number, z: number) =>
    net.addDevice(kind, { name, position: { x, z } });
  const isp = add('cloud', 'ISP', 0, -10);
  const r = add('router', 'EDGE', 0, -5) as Router;
  const s = add('switch', 'SW1', 0, 0);
  const pc1 = add('pc', 'PC1', -6, 5) as Host;
  const pc2 = add('laptop', 'Laptop1', -2, 6) as Host;
  const srv = add('server', 'Server1', 4, 5) as Host;
  const prn = add('printer', 'Printer1', 8, 3) as Host;
  const link = (a: { id: string }, ap: number, b: { id: string }, bp: number) =>
    net.connect({ device: a.id, port: ap }, { device: b.id, port: bp });
  link(pc1, 0, s, 0);
  link(pc2, 0, s, 1);
  link(srv, 0, s, 2);
  link(prn, 0, s, 3);
  link(s, 7, r, 0);
  link(r, 1, isp, 0);
  typeInto(net, 'EDGE', [
    'enable',
    'configure terminal',
    'interface ge0',
    'ip address 192.168.1.1 255.255.255.0',
    'ip nat inside',
    'interface ge1',
    'ip address 203.0.113.2 255.255.255.248',
    'ip nat outside',
    'exit',
    'ip route 0.0.0.0 0.0.0.0 203.0.113.1',
    'ip nat enable',
    'end',
  ]);
  const ip = (t: string) => parseIp(t)!;
  pc1.setStatic(ip('192.168.1.10'), 24, ip('192.168.1.1'));
  pc1.dns = ip('192.0.2.53');
  pc2.setStatic(ip('192.168.1.11'), 24, ip('192.168.1.1'));
  pc2.dns = ip('192.0.2.53');
  srv.setStatic(ip('192.168.1.20'), 24, ip('192.168.1.1'));
  srv.http.enabled = true;
  srv.http.title = 'Team wiki';
  prn.setStatic(ip('192.168.1.30'), 24, ip('192.168.1.1'));
  traffic.add({ kind: 'web', from: pc1.id, to: '192.168.1.20', everyMs: 6000, enabled: true });
  traffic.add({ kind: 'web', from: pc2.id, to: 'www.packetflip.test', everyMs: 9000, enabled: true });
  traffic.add({ kind: 'ping', from: pc1.id, to: '192.168.1.30', everyMs: 8000, enabled: true });
}
