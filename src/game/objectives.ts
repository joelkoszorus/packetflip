/**
 * Objectives are verified by sending real (simulated) traffic, never by
 * inspecting config alone. Checks run on a clone of the player's network so
 * the live board is not disturbed.
 */
import { Network, Host, Cloud, L3Node, ping, parseIp, formatIp, type Ip } from '../sim';
import { cloneNetwork } from '../persistence/serialize';

export interface CheckResult {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface Objective {
  id: string;
  label: string;
  /** Run against a clone; call done exactly once. */
  run(net: Network, done: (pass: boolean, detail: string) => void): void;
}

function findHost(net: Network, name: string): Host | null {
  const d = net.deviceByName(name);
  return d instanceof Host ? d : null;
}

/** "10.0.0.1" or a device name → an IP address. */
function targetIp(net: Network, to: string): Ip | null {
  const literal = parseIp(to);
  if (literal !== null) return literal;
  const d = net.deviceByName(to);
  if (d instanceof L3Node) return d.interfaces.find((i) => i.ip !== null)?.ip ?? null;
  return null;
}

export function canPing(from: string, to: string, label = `${from} can ping ${to}`, expect = true): Objective {
  return {
    id: `ping:${from}>${to}:${expect}`,
    label,
    run(net, done) {
      const src = findHost(net, from);
      if (!src) return done(false, `${from} is missing`);
      const dst = targetIp(net, to);
      if (dst === null) return done(!expect, `${to} has no IP address`);
      const s = ping(src, dst, { count: 2, intervalMs: 500 });
      s.onUpdate = () => {
        if (!s.done) return;
        const ok = s.results.some((r) => r.kind === 'reply');
        const why = s.results.find((r) => r.kind !== 'reply');
        const detail = ok
          ? `Reply from ${formatIp(dst)}`
          : why?.reason ?? (why?.kind === 'timeout' ? 'Request timed out' : 'No reply');
        done(ok === expect, expect ? detail : ok ? `${from} can still reach ${to}` : `Blocked (${detail})`);
      };
    },
  };
}

export function cannotPing(from: string, to: string, label = `${from} cannot reach ${to}`): Objective {
  return canPing(from, to, label, false);
}

export function canBrowse(from: string, target: string, label = `${from} can open http://${target}`, expect = true): Objective {
  return {
    id: `http:${from}>${target}:${expect}`,
    label,
    run(net, done) {
      const src = findHost(net, from);
      if (!src) return done(false, `${from} is missing`);
      src.browse(target, (r) => done(r.ok === expect, expect ? r.message : r.ok ? `${from} can still open it` : `Blocked (${r.message})`));
    },
  };
}

export function cannotBrowse(from: string, target: string, label = `${from} cannot open http://${target}`): Objective {
  return canBrowse(from, target, label, false);
}

export function getsDhcpLease(hostName: string, subnet: string, prefix: number, label = `${hostName} gets an address by DHCP`): Objective {
  const net0 = parseIp(subnet)!;
  return {
    id: `dhcp:${hostName}`,
    label,
    run(net, done) {
      const h = findHost(net, hostName);
      if (!h) return done(false, `${hostName} is missing`);
      if (!h.dhcpEnabled) return done(false, `${hostName} is not set to DHCP`);
      const ip = h.nic.ip;
      if (h.dhcpClient.phase !== 'bound' || ip === null) return done(false, 'No DHCP server answered (got a 169.254.x.x address)');
      const inNet = ((ip ^ net0) >>> (32 - prefix)) === 0;
      done(inNet && h.nic.prefix === prefix, `Leased ${formatIp(ip)}/${h.nic.prefix}`);
    },
  };
}

export function visitorReaches(publicIp: string, label = `Internet visitors can open http://${publicIp}`): Objective {
  return {
    id: `visit:${publicIp}`,
    label,
    run(net, done) {
      const isp = [...net.devices.values()].find((d) => d instanceof Cloud) as Cloud | undefined;
      if (!isp) return done(false, 'No ISP on the board');
      isp.visit(parseIp(publicIp)!, (r) => done(r.ok, r.message));
    },
  };
}

export function noBreach(target: string, ports = [22, 23, 445, 3389], label = `Attacks on ${target} never reach a computer`): Objective {
  return {
    id: `breach:${target}`,
    label,
    run(net, done) {
      const isp = [...net.devices.values()].find((d) => d instanceof Cloud) as Cloud | undefined;
      if (!isp) return done(false, 'No ISP on the board');
      let breaches = 0;
      const victims = new Set<string>();
      const off = net.bus.on((e) => {
        if (e.type === 'breach') {
          breaches++;
          victims.add(net.device(e.device)?.name ?? '?');
        }
      });
      isp.attack(parseIp(target)!, ports);
      net.engine.schedule(20_000, () => {
        off();
        done(breaches === 0, breaches === 0 ? `${ports.length} attack probes stopped` : `${breaches} probes reached ${[...victims].join(', ')}`);
      }, 'breach-check');
    },
  };
}

export function predicate(id: string, label: string, test: (net: Network) => [boolean, string]): Objective {
  return {
    id,
    label,
    run(net, done) {
      const [pass, detail] = test(net);
      done(pass, detail);
    },
  };
}

/** Run every objective on a fresh clone. DHCP clients lease first, like a real morning boot. */
export function runChecks(live: Network, objectives: Objective[]): CheckResult[] {
  const net = cloneNetwork(live);
  for (const d of net.devices.values()) if (d instanceof Host && d.dhcpEnabled) d.useDhcp();
  net.engine.runUntilIdle(60_000);
  const results: CheckResult[] = [];
  for (const o of objectives) {
    let res: CheckResult | null = null;
    try {
      o.run(net, (pass, detail) => {
        if (!res) res = { id: o.id, label: o.label, pass, detail };
      });
      net.engine.runUntilIdle(90_000);
    } catch (err) {
      console.error(err);
    }
    results.push(res ?? { id: o.id, label: o.label, pass: false, detail: 'Check did not finish' });
  }
  return results;
}
