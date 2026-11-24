import { L3Node, type L3Interface, type StaticRoute } from './l3';
import { LIMITS } from '../limits';
import { isValidVlanId } from './switch';
import type { IpPacket } from '../net/pdu';
import type { DropReason } from '../events';
import { evaluateAcl, type AclEntry } from '../services/acl';
import { NatTable, type PortForward } from '../services/nat';
import { DHCP_SERVER_PORT, DhcpServer, handleDhcpServerPort } from '../services/dhcp';

export interface RouterConfig {
  interfaces: L3Interface[];
  staticRoutes: StaticRoute[];
  acls: { name: string; entries: AclEntry[] }[];
  nat: { enabled: boolean; forwards: PortForward[] };
  dhcp: ReturnType<DhcpServer['serialize']>;
}

export class Router extends L3Node {
  readonly forwarding: boolean = true;
  readonly acls = new Map<string, AclEntry[]>();
  readonly nat = new NatTable();
  dhcp!: DhcpServer;
  /** Counters for `show access-lists` (name → hits per entry, last = implicit deny). */
  readonly aclHits = new Map<string, number[]>();

  protected override onAttach(): void {
    this.interfaces = this.ports.map((p) => ({ name: p.name, port: p.index, ip: null, prefix: 24, enabled: true }));
  }

  protected override installServices(): void {
    this.dhcp = new DhcpServer(this);
    this.dhcp.enabled = false;
    this.bindL4('udp', DHCP_SERVER_PORT, (p, iface) =>
      handleDhcpServerPort(this, this.dhcp.enabled ? this.dhcp : null, p, iface),
    );
  }

  /** Create (or return) a router-on-a-stick subinterface like ge0.10 for VLAN 10. */
  addSubinterface(portIndex: number, vlan: number): L3Interface | null {
    const port = this.ports[portIndex];
    if (!port || !isValidVlanId(vlan)) return null;
    const name = `${port.name}.${vlan}`;
    const existing = this.ifaceByName(name);
    if (existing) return existing;
    const iface: L3Interface = { name, port: portIndex, vlan, ip: null, prefix: 24, enabled: true };
    this.interfaces.push(iface);
    this.interfaces.sort((a, b) => a.port - b.port || (a.vlan ?? 0) - (b.vlan ?? 0));
    return iface;
  }

  removeInterface(name: string): boolean {
    const i = this.interfaces.findIndex((x) => x.name === name && x.vlan !== undefined);
    if (i < 0) return false;
    this.interfaces.splice(i, 1);
    return true;
  }

  addStaticRoute(route: StaticRoute): boolean {
    if (this.staticRoutes.length >= LIMITS.maxStaticRoutes) return false;
    if (this.staticRoutes.some((r) => r.net === route.net && r.prefix === route.prefix && r.nextHop === route.nextHop))
      return true;
    this.staticRoutes.push({ ...route });
    return true;
  }

  removeStaticRoute(route: StaticRoute): boolean {
    const before = this.staticRoutes.length;
    this.staticRoutes = this.staticRoutes.filter(
      (r) => !(r.net === route.net && r.prefix === route.prefix && r.nextHop === route.nextHop),
    );
    return this.staticRoutes.length !== before;
  }

  addAclEntry(name: string, entry: AclEntry): boolean {
    const list = this.acls.get(name) ?? [];
    if (list.length >= LIMITS.maxAclEntries) return false;
    list.push({ ...entry });
    this.acls.set(name, list);
    this.aclHits.delete(name);
    return true;
  }

  private checkAcl(name: string | undefined, packet: IpPacket): boolean {
    if (!name) return true;
    const list = this.acls.get(name);
    if (!list) return true; // an applied but undefined ACL permits everything (like real gear)
    const verdict = evaluateAcl(list, packet);
    const hits = this.aclHits.get(name) ?? new Array<number>(list.length + 1).fill(0);
    const slot = verdict.index < 0 ? list.length : verdict.index;
    hits[slot] = (hits[slot] ?? 0) + 1;
    this.aclHits.set(name, hits);
    return verdict.action === 'permit';
  }

  protected override filterInbound(packet: IpPacket, iface: L3Interface): IpPacket | DropReason {
    if (!this.checkAcl(iface.aclIn, packet)) return 'acl-deny';
    if (this.nat.enabled && iface.nat === 'outside' && packet.dst === iface.ip) {
      const translated = this.nat.inbound(packet, this.now);
      if (translated) return translated;
    }
    return packet;
  }

  protected override transformOutbound(
    packet: IpPacket,
    inIface: L3Interface | null,
    outIface: L3Interface,
  ): IpPacket | DropReason {
    if (inIface && !this.checkAcl(outIface.aclOut, packet)) return 'acl-deny';
    if (this.nat.enabled && outIface.nat === 'outside' && outIface.ip !== null && inIface?.nat === 'inside') {
      return this.nat.outbound(packet, outIface.ip, this.now);
    }
    return packet;
  }

  override clearDynamicState(): void {
    super.clearDynamicState();
    this.nat.clear();
  }

  serializeConfig(): RouterConfig {
    return {
      interfaces: this.interfaces.map((i) => ({ ...i })),
      staticRoutes: this.staticRoutes.map((r) => ({ ...r })),
      acls: [...this.acls].map(([name, entries]) => ({ name, entries: entries.map((e) => ({ ...e })) })),
      nat: { enabled: this.nat.enabled, forwards: this.nat.forwards.map((f) => ({ ...f })) },
      dhcp: this.dhcp.serialize(),
    };
  }

  applyConfig(raw: unknown): void {
    const c = raw as RouterConfig;
    this.interfaces = c.interfaces.filter((i) => this.ports[i.port]).map((i) => ({ ...i }));
    this.staticRoutes = c.staticRoutes.map((r) => ({ ...r }));
    this.acls.clear();
    for (const a of c.acls ?? []) this.acls.set(a.name, a.entries.map((e) => ({ ...e })));
    this.nat.enabled = c.nat?.enabled ?? false;
    this.nat.forwards = (c.nat?.forwards ?? []).map((f) => ({ ...f }));
    if (c.dhcp) this.dhcp.load(c.dhcp);
  }
}
