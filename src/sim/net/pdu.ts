/**
 * Protocol data units. PDUs are immutable plain objects: a device that changes a
 * header (VLAN tag, TTL, NAT) creates a new object. That keeps the trace history
 * correct and makes PDUs safe to hand to the renderer and UI.
 */
import type { Ip, Mac } from './addr';

// ---------- Application layer ----------
export type AppPayload =
  | { app: 'http'; kind: 'request'; host: string; path: string }
  | { app: 'http'; kind: 'response'; status: number; body: string }
  | { app: 'dns'; kind: 'query'; id: number; name: string }
  | { app: 'dns'; kind: 'answer'; id: number; name: string; ip: Ip | null }
  | {
      app: 'dhcp';
      kind: 'discover' | 'offer' | 'request' | 'ack' | 'nak';
      xid: number;
      clientMac: Mac;
      yourIp?: Ip;
      prefix?: number;
      gateway?: Ip;
      dns?: Ip;
      serverId?: Ip;
      /** Relay agent address (giaddr) when forwarded by an ip helper. */
      relay?: Ip;
    }
  | { app: 'data'; label: string; bytes: number };

// ---------- Transport layer ----------
export type IcmpType = 'echo-request' | 'echo-reply' | 'dest-unreachable' | 'time-exceeded';

export interface IcmpSegment {
  proto: 'icmp';
  type: IcmpType;
  /** echo identifier / sequence; for errors, the id/seq of the offending echo (if any) */
  id: number;
  seq: number;
  /** For error messages: a short description of why. */
  reason?: string;
  /** For errors: the original packet's destination + id so the sender can match it. */
  original?: { dst: Ip; src: Ip; proto: L4['proto']; srcPort?: number; dstPort?: number; id: number };
}

export interface UdpSegment {
  proto: 'udp';
  srcPort: number;
  dstPort: number;
  payload: AppPayload;
}

export type TcpFlag = 'SYN' | 'SYN-ACK' | 'ACK' | 'PSH' | 'FIN' | 'RST';

/** A simplified TCP: a 3-way handshake, data pushes, and FIN/RST. No windows or retransmit. */
export interface TcpSegment {
  proto: 'tcp';
  srcPort: number;
  dstPort: number;
  flag: TcpFlag;
  payload?: AppPayload;
}

export type L4 = IcmpSegment | UdpSegment | TcpSegment;

// ---------- Network layer ----------
export interface IpPacket {
  /** Packet id, stable across hops (used for tracing). */
  id: number;
  src: Ip;
  dst: Ip;
  ttl: number;
  l4: L4;
  /** Simulation-only tag: marks simulated hostile traffic for scoring. Never "real". */
  hostile?: boolean;
}

export interface ArpPacket {
  op: 'request' | 'reply';
  senderMac: Mac;
  senderIp: Ip;
  targetMac: Mac;
  targetIp: Ip;
}

// ---------- Data-link layer ----------
export type EtherType = 'ipv4' | 'arp';

export interface Frame {
  /** Unique per transmission. */
  uid: number;
  src: Mac;
  dst: Mac;
  /** 802.1Q tag, present only on trunk links. */
  vlan?: number;
  etherType: EtherType;
  payload: IpPacket | ArpPacket;
  /**
   * Simulation-only safety counter (not a real header). Incremented on every
   * switch forward so L2 loops are detected instead of hanging the browser.
   */
  l2hops: number;
}

export function isArp(frame: Frame): frame is Frame & { payload: ArpPacket } {
  return frame.etherType === 'arp';
}

export function isIp(frame: Frame): frame is Frame & { payload: IpPacket } {
  return frame.etherType === 'ipv4';
}

export function pduSize(frame: Frame): number {
  if (frame.etherType === 'arp') return 64;
  const p = frame.payload as IpPacket;
  const l4 = p.l4;
  if (l4.proto === 'icmp') return 98;
  const app = l4.payload;
  if (!app) return 64;
  if (app.app === 'data') return Math.min(1500, 64 + app.bytes);
  if (app.app === 'http' && app.kind === 'response') return Math.min(1500, 200 + app.body.length);
  return 128;
}

/** The colour family a PDU is drawn in, used by the renderer and the trace log. */
export type TrafficClass = 'arp' | 'icmp' | 'dns' | 'dhcp' | 'http' | 'tcp' | 'data' | 'hostile';

export function trafficClass(frame: Frame): TrafficClass {
  if (frame.etherType === 'arp') return 'arp';
  const p = frame.payload as IpPacket;
  if (p.hostile) return 'hostile';
  const l4 = p.l4;
  if (l4.proto === 'icmp') return 'icmp';
  const app = l4.payload;
  if (!app) return 'tcp';
  return app.app;
}
