/**
 * Shared IPv4 stack for every device that has IP interfaces (hosts, routers,
 * firewalls, the ISP cloud): ARP, routing-table lookup, ICMP, local delivery.
 */
import { Device } from './device';
import {
  BROADCAST_MAC,
  IP_BROADCAST,
  broadcastOf,
  formatIp,
  inSubnet,
  networkOf,
  type Ip,
  type Mac,
} from '../net/addr';
import type { ArpPacket, Frame, IcmpSegment, IcmpType, IpPacket, L4 } from '../net/pdu';
import { isArp, isIp } from '../net/pdu';
import type { DropReason } from '../events';
import { LIMITS } from '../limits';
import type { Network } from '../network';

/** Game-time: hops take ~250ms so the player can watch them; timeouts scale to match. */
export const ARP_TIMEOUT_MS = 5000;
export const ARP_CACHE_TTL_MS = 300_000;

export interface L3Interface {
  name: string;
  port: number;
  /** 802.1Q VLAN for router subinterfaces (router-on-a-stick). Undefined = untagged. */
  vlan?: number;
  ip: Ip | null;
  prefix: number;
  enabled: boolean;
  /** Names of ACLs applied to this interface (see services/acl). */
  aclIn?: string;
  aclOut?: string;
  nat?: 'inside' | 'outside';
  /** DHCP relay target ("ip helper-address"). */
  helper?: Ip;
  /** Address learned via DHCP (so the UI can show it as dynamic). */
  dhcp?: boolean;
}

export interface StaticRoute {
  net: Ip;
  prefix: number;
  nextHop: Ip;
}

export interface Route {
  net: Ip;
  prefix: number;
  kind: 'connected' | 'static' | 'default';
  iface: L3Interface;
  nextHop?: Ip;
}

interface ArpEntry {
  mac: Mac;
  expires: number;
  iface: string;
}

interface Pending {
  iface: L3Interface;
  packets: IpPacket[];
}

export type PacketObserver = (packet: IpPacket, iface: L3Interface) => void;
export type FailureObserver = (packet: IpPacket, reason: DropReason) => void;
export type L4Handler = (packet: IpPacket, iface: L3Interface) => void;

export abstract class L3Node extends Device {
  interfaces: L3Interface[] = [];
  staticRoutes: StaticRoute[] = [];
  /** Routers and firewalls forward; end hosts do not. */
  abstract readonly forwarding: boolean;

  readonly arpCache = new Map<string, ArpEntry>();
  private pending = new Map<string, Pending>();
  private icmpObservers = new Set<PacketObserver>();
  private failureObservers = new Set<FailureObserver>();
  /** "udp:53" / "tcp:80" → handler. Used by services and client sockets. */
  protected l4Handlers = new Map<string, L4Handler>();
  private ephemeral = 49152;

  override attach(net: Network, portNames: string[]): void {
    super.attach(net, portNames);
    this.installServices();
  }

  /** Bind built-in protocol handlers (DHCP, DNS, HTTP...). Overridden by subclasses. */
  protected installServices(): void {}

  /** Allocate a client-side ephemeral port. */
  allocPort(): number {
    const p = this.ephemeral;
    this.ephemeral = this.ephemeral >= 65000 ? 49152 : this.ephemeral + 1;
    return p;
  }

  // ---------- public API ----------

  ifaceByName(name: string): L3Interface | undefined {
    const n = name.toLowerCase();
    return this.interfaces.find((i) => i.name.toLowerCase() === n);
  }

  ownsIp(ip: Ip): boolean {
    return this.interfaces.some((i) => i.ip === ip);
  }

  onIcmp(observer: PacketObserver): () => void {
    this.icmpObservers.add(observer);
    return () => this.icmpObservers.delete(observer);
  }

  onLocalFailure(observer: FailureObserver): () => void {
    this.failureObservers.add(observer);
    return () => this.failureObservers.delete(observer);
  }

  bindL4(proto: 'udp' | 'tcp', port: number, handler: L4Handler): () => void {
    const key = `${proto}:${port}`;
    this.l4Handlers.set(key, handler);
    return () => {
      if (this.l4Handlers.get(key) === handler) this.l4Handlers.delete(key);
    };
  }

  /** The routing table, as it would be shown by `show ip route`. */
  routes(): Route[] {
    const routes: Route[] = [];
    for (const iface of this.interfaces) {
      if (iface.ip === null || !iface.enabled || !this.portUp(iface.port)) continue;
      routes.push({ net: networkOf(iface.ip, iface.prefix), prefix: iface.prefix, kind: 'connected', iface });
    }
    for (const sr of this.staticRoutes) {
      const via = this.connectedFor(routes, sr.nextHop);
      if (!via) continue; // next hop unreachable → route inactive
      routes.push({
        net: networkOf(sr.net, sr.prefix),
        prefix: sr.prefix,
        kind: sr.prefix === 0 ? 'default' : 'static',
        iface: via.iface,
        nextHop: sr.nextHop,
      });
    }
    return routes;
  }

  lookup(dst: Ip): Route | null {
    let best: Route | null = null;
    for (const r of this.routes()) {
      if (inSubnet(dst, r.net, r.prefix) && (!best || r.prefix > best.prefix)) best = r;
    }
    return best;
  }

  /** Originate a packet from this node. Returns a drop reason if it could not even leave. */
  sendPacket(dst: Ip, l4: L4, opts: { ttl?: number; via?: L3Interface; src?: Ip; hostile?: boolean } = {}): IpPacket {
    const packet: IpPacket = {
      id: this.net.nextPacketId(),
      src: opts.src ?? 0,
      dst,
      ttl: opts.ttl ?? LIMITS.defaultTtl,
      l4,
      ...(opts.hostile ? { hostile: true } : {}),
    };
    this.originate(packet, opts.via);
    return packet;
  }

  originate(packet: IpPacket, via?: L3Interface): void {
    if (!this.powered) return this.localFailure(packet, 'device-off');
    // Loopback
    if (this.ownsIp(packet.dst)) {
      const iface = this.interfaces.find((i) => i.ip === packet.dst) ?? this.interfaces[0]!;
      const p = { ...packet, src: packet.src || packet.dst };
      this.net.engine.schedule(1, () => this.deliverLocal(p, iface), 'loopback');
      return;
    }
    // Limited broadcast (DHCP) goes out a specific interface.
    if (packet.dst === IP_BROADCAST) {
      const iface = via ?? this.interfaces[0];
      if (!iface) return this.localFailure(packet, 'no-l3-interface');
      this.emit(iface, BROADCAST_MAC, { ...packet, src: packet.src || iface.ip || 0 });
      return;
    }
    const route = this.routeFor(packet.dst);
    if ('reason' in route) return this.localFailure(packet, route.reason);
    const src = packet.src || route.iface.ip || 0;
    const out = this.transformOutbound({ ...packet, src }, null, route.iface);
    if (typeof out === 'string') return this.localFailure(packet, out);
    this.resolveAndSend(route.iface, route.nextHop ?? packet.dst, out, true);
  }

  override clearDynamicState(): void {
    this.arpCache.clear();
    this.pending.clear();
  }

  // ---------- receive path ----------

  receive(frame: Frame, portIndex: number): void {
    if (!this.powered) return;
    const port = this.ports[portIndex];
    if (!port) return;
    // NIC filter: frames for other MACs are silently ignored (that is normal on a LAN).
    if (frame.dst !== port.mac && frame.dst !== BROADCAST_MAC) return;
    const iface = this.interfaces.find((i) => i.port === portIndex && i.vlan === frame.vlan && i.enabled);
    if (!iface) {
      this.drop('no-l3-interface', frame, frame.vlan !== undefined ? `VLAN ${frame.vlan}` : undefined);
      return;
    }
    if (isArp(frame)) this.handleArp(frame.payload, iface);
    else if (isIp(frame)) this.handleIp(frame.payload, iface, frame);
  }

  private handleArp(arp: ArpPacket, iface: L3Interface): void {
    if (iface.ip === null) return;
    const forMe = arp.targetIp === iface.ip;
    const key = this.arpKey(iface, arp.senderIp);
    if (forMe || this.arpCache.has(key)) {
      this.arpCache.set(key, { mac: arp.senderMac, expires: this.now + ARP_CACHE_TTL_MS, iface: iface.name });
      this.flushPending(iface, arp.senderIp, arp.senderMac);
    }
    if (arp.op === 'request' && forMe) {
      const port = this.ports[iface.port]!;
      const reply: ArpPacket = {
        op: 'reply',
        senderMac: port.mac,
        senderIp: iface.ip,
        targetMac: arp.senderMac,
        targetIp: arp.senderIp,
      };
      this.transmit(iface.port, {
        src: port.mac,
        dst: arp.senderMac,
        ...(iface.vlan !== undefined ? { vlan: iface.vlan } : {}),
        etherType: 'arp',
        payload: reply,
        l2hops: 0,
      });
    }
  }

  private handleIp(packet: IpPacket, iface: L3Interface, frame: Frame): void {
    const inbound = this.filterInbound(packet, iface);
    if (typeof inbound === 'string') return this.drop(inbound, frame);
    packet = inbound;
    const isBroadcast =
      packet.dst === IP_BROADCAST || (iface.ip !== null && packet.dst === broadcastOf(iface.ip, iface.prefix));
    if (this.ownsIp(packet.dst) || isBroadcast || (iface.ip === null && frame.dst === this.ports[iface.port]!.mac)) {
      const local = this.interfaces.find((i) => i.ip === packet.dst) ?? iface;
      if (packet.hostile && !this.forwarding) this.net.reportBreach(this.id, packet);
      this.deliverLocal(packet, local);
      return;
    }
    if (!this.forwarding) return this.drop('not-a-router', frame, `for ${formatIp(packet.dst)}`);
    this.forward(packet, iface, frame);
  }

  private forward(packet: IpPacket, inIface: L3Interface, frame: Frame): void {
    if (packet.ttl <= 1) {
      this.sendIcmpError(packet, 'time-exceeded', inIface, 'TTL expired in transit');
      return this.drop('ttl-expired', frame);
    }
    const route = this.routeFor(packet.dst);
    if ('reason' in route) {
      this.sendIcmpError(packet, 'dest-unreachable', inIface, 'Network unreachable');
      return this.drop(route.reason, frame, formatIp(packet.dst));
    }
    const out = this.transformOutbound({ ...packet, ttl: packet.ttl - 1 }, inIface, route.iface);
    if (typeof out === 'string') {
      if (out === 'acl-deny' || out === 'firewall-deny') {
        this.sendIcmpError(packet, 'dest-unreachable', inIface, 'Administratively prohibited');
      }
      return this.drop(out, frame);
    }
    this.resolveAndSend(route.iface, route.nextHop ?? out.dst, out, false);
  }

  protected deliverLocal(packet: IpPacket, iface: L3Interface): void {
    const l4 = packet.l4;
    if (l4.proto === 'icmp') {
      if (l4.type === 'echo-request' && iface.ip !== null) {
        const reply: IcmpSegment = { proto: 'icmp', type: 'echo-reply', id: l4.id, seq: l4.seq };
        this.sendPacket(packet.src, reply, { src: this.ownsIp(packet.dst) ? packet.dst : iface.ip });
      }
      for (const obs of this.icmpObservers) obs(packet, iface);
      this.net.reportDeliver(this.id, packet);
      return;
    }
    const handler = this.l4Handlers.get(`${l4.proto}:${l4.dstPort}`);
    if (handler) {
      this.net.reportDeliver(this.id, packet);
      handler(packet, iface);
      return;
    }
    if (packet.dst === IP_BROADCAST) return; // unanswered broadcast: ignore quietly
    if (l4.proto === 'tcp' && l4.flag !== 'RST') {
      this.sendPacket(packet.src, { proto: 'tcp', srcPort: l4.dstPort, dstPort: l4.srcPort, flag: 'RST' });
    } else if (l4.proto === 'udp') {
      this.sendIcmpError(packet, 'dest-unreachable', iface, 'Port unreachable');
    }
    this.drop('port-unreachable', undefined, `${l4.proto}/${l4.dstPort}`);
  }

  // ---------- hooks for ACL / NAT / firewall (overridden in later layers) ----------

  /** Inbound filtering on the ingress interface (ACL in, firewall). */
  protected filterInbound(packet: IpPacket, _iface: L3Interface): IpPacket | DropReason {
    return packet;
  }

  /** Outbound transform (ACL out, NAT). inIface is null for locally originated packets. */
  protected transformOutbound(
    packet: IpPacket,
    _inIface: L3Interface | null,
    _outIface: L3Interface,
  ): IpPacket | DropReason {
    return packet;
  }

  // ---------- helpers ----------

  protected routeFor(dst: Ip): Route | { reason: DropReason } {
    const route = this.lookup(dst);
    if (route) return route;
    return { reason: this.noRouteReason(dst) };
  }

  /** Hosts override this to explain *why* (no gateway, gateway off-subnet...). */
  protected noRouteReason(_dst: Ip): DropReason {
    return this.interfaces.some((i) => i.ip !== null) ? 'no-route' : 'no-ip';
  }

  private connectedFor(routes: Route[], ip: Ip): Route | undefined {
    return routes.find((r) => r.kind === 'connected' && inSubnet(ip, r.net, r.prefix));
  }

  private arpKey(iface: L3Interface, ip: Ip): string {
    return `${iface.name}|${ip}`;
  }

  private resolveAndSend(iface: L3Interface, nextHop: Ip, packet: IpPacket, local: boolean): void {
    if (iface.ip !== null && nextHop === broadcastOf(iface.ip, iface.prefix)) {
      this.emit(iface, BROADCAST_MAC, packet);
      return;
    }
    const key = this.arpKey(iface, nextHop);
    const hit = this.arpCache.get(key);
    if (hit && hit.expires > this.now) {
      this.emit(iface, hit.mac, packet);
      return;
    }
    let pend = this.pending.get(key);
    if (pend) {
      if (pend.packets.length >= LIMITS.maxArpPending) {
        if (local) this.localFailure(packet, 'arp-queue-full');
        else this.drop('arp-queue-full');
        return;
      }
      pend.packets.push(packet);
      return;
    }
    pend = { iface, packets: [packet] };
    this.pending.set(key, pend);
    const port = this.ports[iface.port]!;
    const request: ArpPacket = {
      op: 'request',
      senderMac: port.mac,
      senderIp: iface.ip ?? 0,
      targetMac: '00:00:00:00:00:00',
      targetIp: nextHop,
    };
    this.transmit(iface.port, {
      src: port.mac,
      dst: BROADCAST_MAC,
      ...(iface.vlan !== undefined ? { vlan: iface.vlan } : {}),
      etherType: 'arp',
      payload: request,
      l2hops: 0,
    });
    this.net.engine.schedule(
      ARP_TIMEOUT_MS,
      () => {
        const still = this.pending.get(key);
        if (still !== pend) return;
        this.pending.delete(key);
        for (const p of still.packets) {
          if (p.src !== 0 && this.ownsIp(p.src)) this.localFailure(p, 'arp-timeout');
          else {
            this.sendIcmpError(p, 'dest-unreachable', iface, 'Host unreachable');
            this.drop('arp-timeout', undefined, formatIp(nextHop));
          }
        }
      },
      'arp-timeout',
    );
  }

  private flushPending(iface: L3Interface, ip: Ip, mac: Mac): void {
    const key = this.arpKey(iface, ip);
    const pend = this.pending.get(key);
    if (!pend) return;
    this.pending.delete(key);
    for (const p of pend.packets) this.emit(iface, mac, p);
  }

  private emit(iface: L3Interface, dstMac: Mac, packet: IpPacket): void {
    const port = this.ports[iface.port]!;
    this.transmit(iface.port, {
      src: port.mac,
      dst: dstMac,
      ...(iface.vlan !== undefined ? { vlan: iface.vlan } : {}),
      etherType: 'ipv4',
      payload: packet,
      l2hops: 0,
    });
  }

  protected sendIcmpError(about: IpPacket, type: IcmpType, iface: L3Interface, reason: string): void {
    // Never send ICMP errors about ICMP errors, or about broadcasts / unknown sources.
    if (about.l4.proto === 'icmp' && about.l4.type !== 'echo-request' && about.l4.type !== 'echo-reply') return;
    if (about.src === 0 || about.dst === IP_BROADCAST) return;
    const src = iface.ip ?? this.interfaces.find((i) => i.ip !== null)?.ip;
    if (src === undefined || src === null) return;
    const l4 = about.l4;
    const original = {
      dst: about.dst,
      src: about.src,
      proto: l4.proto,
      id: about.id,
      ...(l4.proto !== 'icmp' ? { srcPort: l4.srcPort, dstPort: l4.dstPort } : {}),
    };
    const err: IcmpSegment = {
      proto: 'icmp',
      type,
      id: l4.proto === 'icmp' ? l4.id : 0,
      seq: l4.proto === 'icmp' ? l4.seq : 0,
      reason,
      original,
    };
    this.sendPacket(about.src, err, { src });
  }

  protected localFailure(packet: IpPacket, reason: DropReason): void {
    this.drop(reason, undefined, formatIp(packet.dst));
    // Notify asynchronously so callers (ping) can register the packet id first.
    this.net.engine.schedule(0, () => {
      for (const obs of this.failureObservers) obs(packet, reason);
    }, 'local-failure');
  }
}
