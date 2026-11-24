/**
 * Simplified DHCP (DORA: Discover, Offer, Request, Ack) with relay support
 * ("ip helper-address") and APIPA fallback on clients.
 */
import { IP_BROADCAST, formatIp, inSubnet, networkOf, type Ip, type Mac } from '../net/addr';
import type { AppPayload, IpPacket } from '../net/pdu';
import type { L3Interface, L3Node } from '../devices/l3';

export const DHCP_SERVER_PORT = 67;
export const DHCP_CLIENT_PORT = 68;

export interface DhcpPool {
  name: string;
  network: Ip;
  prefix: number;
  start: Ip;
  end: Ip;
  gateway: Ip | null;
  dns: Ip | null;
}

export interface DhcpLease {
  mac: Mac;
  ip: Ip;
  pool: string;
  at: number;
}

type DhcpMsg = Extract<AppPayload, { app: 'dhcp' }>;

export class DhcpServer {
  enabled = true;
  pools: DhcpPool[] = [];
  readonly leases = new Map<Mac, DhcpLease>();
  /** Addresses never handed out ("ip dhcp excluded-address"). */
  excluded: Ip[] = [];

  constructor(private readonly node: L3Node) {}

  poolFor(subnetIp: Ip): DhcpPool | undefined {
    return this.pools.find((p) => inSubnet(subnetIp, p.network, p.prefix));
  }

  private inUse(ip: Ip, mac: Mac): boolean {
    if (this.excluded.includes(ip) || this.node.ownsIp(ip)) return true;
    for (const l of this.leases.values()) if (l.ip === ip && l.mac !== mac) return true;
    return false;
  }

  allocate(pool: DhcpPool, mac: Mac): Ip | null {
    const existing = this.leases.get(mac);
    if (existing && existing.pool === pool.name) return existing.ip;
    for (let ip = pool.start; ip <= pool.end; ip++) {
      if (ip === pool.gateway || ip === pool.dns) continue;
      if (!this.inUse(ip, mac)) return ip;
    }
    return null;
  }

  /** Handle a client message (directly or relayed). Returns the reply, or null. */
  serve(msg: DhcpMsg, ingress: L3Interface): DhcpMsg | null {
    if (!this.enabled) return null;
    const lookupIp = msg.relay ?? ingress.ip;
    if (lookupIp === null) return null;
    const pool = this.poolFor(lookupIp);
    if (!pool) return null;
    const base = {
      app: 'dhcp' as const,
      xid: msg.xid,
      clientMac: msg.clientMac,
      prefix: pool.prefix,
      ...(pool.gateway !== null ? { gateway: pool.gateway } : {}),
      ...(pool.dns !== null ? { dns: pool.dns } : {}),
      ...(ingress.ip !== null ? { serverId: ingress.ip } : {}),
      ...(msg.relay !== undefined ? { relay: msg.relay } : {}),
    };
    if (msg.kind === 'discover') {
      const ip = this.allocate(pool, msg.clientMac);
      if (ip === null) return null; // pool exhausted
      return { ...base, kind: 'offer', yourIp: ip };
    }
    if (msg.kind === 'request' && msg.yourIp !== undefined) {
      const ok = inSubnet(msg.yourIp, pool.network, pool.prefix) && !this.inUse(msg.yourIp, msg.clientMac);
      if (!ok) return { ...base, kind: 'nak' };
      this.leases.set(msg.clientMac, { mac: msg.clientMac, ip: msg.yourIp, pool: pool.name, at: this.node.network.engine.now });
      return { ...base, kind: 'ack', yourIp: msg.yourIp };
    }
    return null;
  }

  serialize() {
    return { enabled: this.enabled, pools: this.pools.map((p) => ({ ...p })), excluded: [...this.excluded] };
  }

  load(c: ReturnType<DhcpServer['serialize']>): void {
    this.enabled = c.enabled;
    this.pools = c.pools.map((p) => ({ ...p }));
    this.excluded = [...c.excluded];
  }
}


/**
 * The udp/67 handler installed on every L3 node: relays client broadcasts when
 * a helper address is set, serves them if the node runs a DHCP server, and
 * forwards relayed server replies back onto the client's segment.
 */
export function handleDhcpServerPort(node: L3Node, server: DhcpServer | null, packet: IpPacket, iface: L3Interface): void {
  const l4 = packet.l4;
  if (l4.proto !== 'udp' || l4.payload.app !== 'dhcp') return;
  const msg = l4.payload;
  const fromClient = msg.kind === 'discover' || msg.kind === 'request';

  if (fromClient) {
    // Relay: broadcast from a local client, helper configured, not already relayed.
    if (iface.helper !== undefined && msg.relay === undefined && iface.ip !== null) {
      const relayed: DhcpMsg = { ...msg, relay: iface.ip };
      node.sendPacket(iface.helper, { proto: 'udp', srcPort: DHCP_SERVER_PORT, dstPort: DHCP_SERVER_PORT, payload: relayed }, { src: iface.ip });
      return;
    }
    if (!server) return;
    const reply = server.serve(msg, iface);
    if (!reply) return;
    const relay = msg.relay;
    if (relay !== undefined) {
      node.sendPacket(relay, { proto: 'udp', srcPort: DHCP_SERVER_PORT, dstPort: DHCP_SERVER_PORT, payload: reply });
    } else {
      node.sendPacket(IP_BROADCAST, { proto: 'udp', srcPort: DHCP_SERVER_PORT, dstPort: DHCP_CLIENT_PORT, payload: reply }, { via: iface, ...(iface.ip !== null ? { src: iface.ip } : {}) });
    }
    return;
  }
  // A relayed reply from a remote server: put it on the client's segment.
  const relay = msg.relay;
  if (relay === undefined) return;
  const out = node.interfaces.find((i) => i.ip === relay);
  if (!out) return;
  const { relay: _r, ...clean } = msg;
  node.sendPacket(IP_BROADCAST, { proto: 'udp', srcPort: DHCP_SERVER_PORT, dstPort: DHCP_CLIENT_PORT, payload: clean }, { via: out, src: relay });
}

// ---------------- client ----------------

export const DHCP_RETRY_MS = 8000;
export const DHCP_MAX_TRIES = 3;

export interface DhcpClientHost extends L3Node {
  gateway: Ip | null;
  dns: Ip | null;
}

export class DhcpClient {
  private xid = 0;
  private tries = 0;
  phase: 'idle' | 'discovering' | 'requesting' | 'bound' | 'failed' = 'idle';
  private unbind: (() => void) | null = null;
  private onDone: ((ok: boolean) => void) | undefined;

  constructor(private readonly host: DhcpClientHost) {}

  start(onDone?: (ok: boolean) => void): void {
    this.onDone = onDone;
    const nic = this.host.interfaces[0]!;
    nic.ip = null;
    nic.dhcp = true;
    this.host.gateway = null;
    this.host.dns = null;
    this.host.clearDynamicState();
    this.unbind?.();
    this.unbind = this.host.bindL4('udp', DHCP_CLIENT_PORT, (p) => this.onPacket(p));
    this.tries = 0;
    this.discover();
  }

  stop(): void {
    this.unbind?.();
    this.unbind = null;
    this.phase = 'idle';
  }

  private discover(): void {
    this.tries++;
    this.phase = 'discovering';
    this.xid = (Math.imul(this.tries, 2654435761) ^ this.host.ports[0]!.mac.length ^ this.host.network.engine.now) >>> 0;
    const xid = this.xid;
    this.send({ app: 'dhcp', kind: 'discover', xid, clientMac: this.host.ports[0]!.mac });
    this.host.network.engine.schedule(DHCP_RETRY_MS, () => {
      if (this.xid !== xid || this.phase === 'bound' || this.phase === 'idle') return;
      if (this.tries < DHCP_MAX_TRIES) this.discover();
      else this.fallbackApipa();
    }, 'dhcp-retry');
  }

  private send(payload: DhcpMsg): void {
    const nic = this.host.interfaces[0]!;
    this.host.sendPacket(IP_BROADCAST, { proto: 'udp', srcPort: DHCP_CLIENT_PORT, dstPort: DHCP_SERVER_PORT, payload }, { via: nic, src: 0 });
  }

  private onPacket(packet: IpPacket): void {
    const l4 = packet.l4;
    if (l4.proto !== 'udp' || l4.payload.app !== 'dhcp') return;
    const msg = l4.payload;
    if (msg.xid !== this.xid || msg.clientMac !== this.host.ports[0]!.mac) return;
    if (msg.kind === 'offer' && this.phase === 'discovering' && msg.yourIp !== undefined) {
      this.phase = 'requesting';
      this.send({ ...msg, kind: 'request' });
    } else if (msg.kind === 'ack' && this.phase === 'requesting' && msg.yourIp !== undefined) {
      const nic = this.host.interfaces[0]!;
      nic.ip = msg.yourIp;
      nic.prefix = msg.prefix ?? 24;
      nic.dhcp = true;
      this.host.gateway = msg.gateway ?? null;
      this.host.dns = msg.dns ?? null;
      this.phase = 'bound';
      this.host.network.log(this.host.id, `DHCP: leased ${formatIp(msg.yourIp)}/${nic.prefix}`);
      this.host.network.configChanged(this.host.id);
      this.onDone?.(true);
    } else if (msg.kind === 'nak') {
      this.discover();
    }
  }

  private fallbackApipa(): void {
    const nic = this.host.interfaces[0]!;
    const mac = this.host.ports[0]!.mac.split(':').map((h) => parseInt(h, 16));
    const third = Math.max(1, Math.min(254, mac[4] ?? 1));
    const fourth = Math.max(1, Math.min(254, mac[5] ?? 1));
    nic.ip = networkOf(0xa9fe0000, 16) + third * 256 + fourth; // 169.254.x.y
    nic.prefix = 16;
    this.phase = 'failed';
    this.host.network.log(this.host.id, `DHCP: no server answered; self-assigned ${formatIp(nic.ip)} (APIPA)`);
    this.host.network.configChanged(this.host.id);
    this.onDone?.(false);
  }
}
