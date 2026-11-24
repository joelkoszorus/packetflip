import { Network } from '../src/sim';
import { Host } from '../src/sim/devices/host';
import { Switch } from '../src/sim/devices/switch';
import { Router } from '../src/sim/devices/router';
import { parseIp, type Ip } from '../src/sim/net/addr';
import { ping, traceroute, type ProbeSession } from '../src/sim/diag/ping';
import type { L3Node } from '../src/sim/devices/l3';
import type { SimEvent } from '../src/sim/events';

export function ip(text: string): Ip {
  const v = parseIp(text);
  if (v === null) throw new Error(`bad ip ${text}`);
  return v;
}

export function host(net: Network, name: string, addr?: string, prefix = 24, gw?: string): Host {
  const h = net.addDevice<Host>('pc', { name });
  if (addr) h.setStatic(ip(addr), prefix, gw ? ip(gw) : null);
  return h;
}

export function sw(net: Network, name = 'SW1'): Switch {
  return net.addDevice<Switch>('switch', { name });
}

export function router(net: Network, name = 'R1'): Router {
  return net.addDevice<Router>('router', { name });
}

export function cable(net: Network, a: { id: string }, ap: number, b: { id: string }, bp: number) {
  return net.connect({ device: a.id, port: ap }, { device: b.id, port: bp });
}

export function setIf(r: Router, name: string, addr: string, prefix = 24) {
  const i = r.ifaceByName(name);
  if (!i) throw new Error(`no iface ${name}`);
  i.ip = ip(addr);
  i.prefix = prefix;
}

export function runPing(node: L3Node, dst: string, count = 3): ProbeSession {
  const s = ping(node, ip(dst), { count });
  node.network.engine.runUntilIdle(120_000);
  return s;
}

export function runTrace(node: L3Node, dst: string): ProbeSession {
  const s = traceroute(node, ip(dst));
  node.network.engine.runUntilIdle(300_000);
  return s;
}

export function collect(net: Network): SimEvent[] {
  const events: SimEvent[] = [];
  net.bus.on((e) => events.push(e));
  return events;
}

export const replies = (s: ProbeSession) => s.results.filter((r) => r.kind === 'reply').length;
