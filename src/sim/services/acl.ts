/**
 * Extended access lists. First match wins; an implicit "deny any" ends every list.
 */
import { formatIp, inSubnet, type Ip } from '../net/addr';
import type { IpPacket } from '../net/pdu';

export type AclProto = 'ip' | 'icmp' | 'tcp' | 'udp';

export type AddrMatch = { any: true } | { net: Ip; prefix: number };

export interface AclEntry {
  action: 'permit' | 'deny';
  proto: AclProto;
  src: AddrMatch;
  dst: AddrMatch;
  /** Destination port (tcp/udp only). */
  dstPort?: number;
}

export interface AclVerdict {
  action: 'permit' | 'deny';
  /** Index of the matching entry, or -1 for the implicit deny. */
  index: number;
}

export function addrMatches(m: AddrMatch, ip: Ip): boolean {
  return 'any' in m ? true : inSubnet(ip, m.net, m.prefix);
}

export function entryMatches(e: AclEntry, p: IpPacket): boolean {
  if (e.proto !== 'ip' && e.proto !== p.l4.proto) return false;
  if (!addrMatches(e.src, p.src) || !addrMatches(e.dst, p.dst)) return false;
  if (e.dstPort !== undefined) {
    if (p.l4.proto === 'icmp') return false;
    if (p.l4.dstPort !== e.dstPort) return false;
  }
  return true;
}

export function evaluateAcl(entries: readonly AclEntry[], p: IpPacket): AclVerdict {
  for (const [index, e] of entries.entries()) {
    if (entryMatches(e, p)) return { action: e.action, index };
  }
  return { action: 'deny', index: -1 };
}

export function formatAddrMatch(m: AddrMatch): string {
  if ('any' in m) return 'any';
  if (m.prefix === 32) return `host ${formatIp(m.net)}`;
  return `${formatIp(m.net)}/${m.prefix}`;
}

export function formatAclEntry(e: AclEntry): string {
  const port = e.dstPort !== undefined ? ` eq ${e.dstPort}` : '';
  return `${e.action} ${e.proto} ${formatAddrMatch(e.src)} ${formatAddrMatch(e.dst)}${port}`;
}
