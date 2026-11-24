/**
 * NAT overload (PAT) plus static port forwards.
 * Inside interfaces are marked nat=inside; the outside interface's address is shared.
 */
import type { Ip } from '../net/addr';
import type { IpPacket, L4 } from '../net/pdu';

export interface PortForward {
  proto: 'tcp' | 'udp';
  outsidePort: number;
  insideIp: Ip;
  insidePort: number;
}

interface Translation {
  proto: L4['proto'];
  insideIp: Ip;
  insidePort: number;
  publicPort: number;
  lastUsed: number;
}

export const NAT_TIMEOUT_MS = 300_000;

export class NatTable {
  enabled = false;
  forwards: PortForward[] = [];
  private byInside = new Map<string, Translation>();
  private byPublic = new Map<string, Translation>();
  private nextPort = 1024;

  /** Translate an inside→outside packet's source to the public address. */
  outbound(p: IpPacket, publicIp: Ip, now: number): IpPacket {
    const l4 = p.l4;
    // Port-forward return traffic keeps its forwarded public port.
    if (l4.proto === 'tcp' || l4.proto === 'udp') {
      const fwd = this.forwards.find((f) => f.proto === l4.proto && f.insideIp === p.src && f.insidePort === l4.srcPort);
      if (fwd) return { ...p, src: publicIp, l4: { ...l4, srcPort: fwd.outsidePort } };
    }
    const insidePort = portOf(p);
    const key = `${l4.proto}|${p.src}|${insidePort}`;
    let t = this.byInside.get(key);
    if (!t) {
      t = { proto: l4.proto, insideIp: p.src, insidePort, publicPort: this.allocate(l4.proto), lastUsed: now };
      this.byInside.set(key, t);
      this.byPublic.set(`${l4.proto}|${t.publicPort}`, t);
    }
    t.lastUsed = now;
    return { ...p, src: publicIp, l4: withSrcPort(l4, t.publicPort) };
  }

  /** Translate an outside→public packet back to the inside host, or null if no mapping exists. */
  inbound(p: IpPacket, now: number): IpPacket | null {
    const l4 = p.l4;
    if (l4.proto === 'icmp' && (l4.type === 'dest-unreachable' || l4.type === 'time-exceeded') && l4.original) {
      // Error about a translated packet: match on the echo id / original source port.
      const o = l4.original;
      const port = o.proto === 'icmp' ? l4.id : o.srcPort ?? -1;
      const t = this.byPublic.get(`${o.proto}|${port}`);
      if (!t) return null;
      return {
        ...p,
        dst: t.insideIp,
        l4: { ...l4, id: o.proto === 'icmp' ? t.insidePort : l4.id, original: { ...o, src: t.insideIp, ...(o.srcPort !== undefined ? { srcPort: t.insidePort } : {}) } },
      };
    }
    if (l4.proto === 'tcp' || l4.proto === 'udp') {
      const fwd = this.forwards.find((f) => f.proto === l4.proto && f.outsidePort === l4.dstPort);
      if (fwd) return { ...p, dst: fwd.insideIp, l4: { ...l4, dstPort: fwd.insidePort } };
    }
    const t = this.byPublic.get(`${l4.proto}|${dstPortOf(p)}`);
    if (!t || now - t.lastUsed > NAT_TIMEOUT_MS) return null;
    t.lastUsed = now;
    return { ...p, dst: t.insideIp, l4: withDstPort(l4, t.insidePort) };
  }

  translations(): { proto: string; inside: Ip; insidePort: number; publicPort: number }[] {
    return [...this.byInside.values()].map((t) => ({ proto: t.proto, inside: t.insideIp, insidePort: t.insidePort, publicPort: t.publicPort }));
  }

  clear(): void {
    this.byInside.clear();
    this.byPublic.clear();
  }

  private allocate(proto: string): number {
    for (let i = 0; i < 64000; i++) {
      const port = this.nextPort;
      this.nextPort = this.nextPort >= 65000 ? 1024 : this.nextPort + 1;
      if (!this.byPublic.has(`${proto}|${port}`) && !this.forwards.some((f) => f.outsidePort === port)) return port;
    }
    return 65001;
  }
}

/** For ICMP echo, the echo identifier plays the role of the port. */
function portOf(p: IpPacket): number {
  return p.l4.proto === 'icmp' ? p.l4.id : p.l4.srcPort;
}
function dstPortOf(p: IpPacket): number {
  return p.l4.proto === 'icmp' ? p.l4.id : p.l4.dstPort;
}
function withSrcPort(l4: L4, port: number): L4 {
  return l4.proto === 'icmp' ? { ...l4, id: port } : { ...l4, srcPort: port };
}
function withDstPort(l4: L4, port: number): L4 {
  return l4.proto === 'icmp' ? { ...l4, id: port } : { ...l4, dstPort: port };
}
