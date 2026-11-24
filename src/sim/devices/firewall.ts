/**
 * Stateful firewall with security zones (inside 100, dmz 50, outside 0).
 * - Traffic from a higher-security zone to a lower one is allowed and tracked.
 * - Replies to tracked connections are allowed back.
 * - Everything else needs an explicit allow rule, otherwise 'firewall-deny'.
 * It is also a full router (static routes, ACLs, NAT).
 */
import { Router, type RouterConfig } from './router';
import type { L3Interface } from './l3';
import type { IpPacket } from '../net/pdu';
import type { DropReason } from '../events';
import { addrMatches, type AddrMatch } from '../services/acl';
import { LIMITS } from '../limits';
import { registerDeviceFactory } from '../network';

export type Zone = 'inside' | 'dmz' | 'outside';
export const ZONE_LEVEL: Record<Zone, number> = { inside: 100, dmz: 50, outside: 0 };

export interface FirewallRule {
  from: Zone;
  to: Zone;
  proto: 'ip' | 'icmp' | 'tcp' | 'udp';
  dst: AddrMatch;
  dstPort?: number;
}

export interface FirewallConfig extends RouterConfig {
  rules: FirewallRule[];
}

const CONN_TTL_MS = 120_000;

function flowKey(proto: string, src: number, sport: number, dst: number, dport: number): string {
  return `${proto}|${src}|${sport}|${dst}|${dport}`;
}

function ports(p: IpPacket): [number, number] {
  const l4 = p.l4;
  return l4.proto === 'icmp' ? [l4.id, l4.id] : [l4.srcPort, l4.dstPort];
}

export class Firewall extends Router {
  rules: FirewallRule[] = [];
  private conns = new Map<string, number>();
  denied = 0;

  zoneOf(iface: L3Interface): Zone {
    const base = iface.name.split('.')[0] as Zone;
    return base in ZONE_LEVEL ? base : 'outside';
  }

  addRule(rule: FirewallRule): boolean {
    if (this.rules.length >= LIMITS.maxAclEntries) return false;
    this.rules.push({ ...rule });
    return true;
  }

  private policy(packet: IpPacket, inIface: L3Interface, outIface: L3Interface): boolean {
    const from = this.zoneOf(inIface);
    const to = this.zoneOf(outIface);
    const [sp, dp] = ports(packet);
    const proto = packet.l4.proto;
    const now = this.now;
    // Return traffic for a tracked flow?
    const reverse = flowKey(proto, packet.dst, dp, packet.src, sp);
    const seen = this.conns.get(reverse);
    if (seen !== undefined && now - seen < CONN_TTL_MS) {
      this.conns.set(reverse, now);
      return true;
    }
    // ICMP errors relating to a tracked flow are allowed back too.
    if (proto === 'icmp' && packet.l4.proto === 'icmp' && packet.l4.original) {
      const o = packet.l4.original;
      const k = o.proto === 'icmp'
        ? flowKey('icmp', o.src, packet.l4.id, o.dst, packet.l4.id)
        : flowKey(o.proto, o.src, o.srcPort ?? 0, o.dst, o.dstPort ?? 0);
      if (this.conns.has(k)) return true;
    }
    const allowed =
      ZONE_LEVEL[from] > ZONE_LEVEL[to] ||
      this.rules.some(
        (r) =>
          r.from === from &&
          r.to === to &&
          (r.proto === 'ip' || r.proto === proto) &&
          addrMatches(r.dst, packet.dst) &&
          (r.dstPort === undefined || (proto !== 'icmp' && r.dstPort === dp)),
      );
    if (allowed) {
      if (this.conns.size > 5000) this.conns.clear();
      this.conns.set(flowKey(proto, packet.src, sp, packet.dst, dp), now);
    }
    return allowed;
  }

  protected override transformOutbound(
    packet: IpPacket,
    inIface: L3Interface | null,
    outIface: L3Interface,
  ): IpPacket | DropReason {
    if (inIface && !this.policy(packet, inIface, outIface)) {
      this.denied++;
      return 'firewall-deny';
    }
    return super.transformOutbound(packet, inIface, outIface);
  }

  override clearDynamicState(): void {
    super.clearDynamicState();
    this.conns.clear();
  }

  override serializeConfig(): FirewallConfig {
    return { ...super.serializeConfig(), rules: this.rules.map((r) => ({ ...r })) };
  }

  override applyConfig(raw: unknown): void {
    super.applyConfig(raw);
    this.rules = ((raw as FirewallConfig).rules ?? []).map((r) => ({ ...r }));
  }
}

registerDeviceFactory('firewall', (id, _k, name, pos) => new Firewall(id, 'firewall', name, pos));
