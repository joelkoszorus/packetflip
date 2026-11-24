/**
 * IPv4 / MAC address utilities. IPv4 addresses are unsigned 32-bit integers.
 * All parsers are strict and return null on bad input (they never throw),
 * because they are fed directly from player input and imported files.
 */

export type Ip = number;
export type Mac = string;

export const BROADCAST_MAC: Mac = 'ff:ff:ff:ff:ff:ff';
export const IP_ANY: Ip = 0;
export const IP_BROADCAST: Ip = 0xffffffff;

const OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export function parseIp(text: string): Ip | null {
  if (typeof text !== 'string' || text.length > 15) return null;
  const parts = text.trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!OCTET.test(part)) return null;
    value = value * 256 + Number(part);
  }
  return value >>> 0;
}

export function formatIp(ip: Ip): string {
  return [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');
}

export function maskFromPrefix(prefix: number): Ip {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return IP_BROADCAST;
  return (IP_BROADCAST << (32 - prefix)) >>> 0;
}

/** Returns the prefix length for a contiguous netmask, or null if the mask is not contiguous. */
export function prefixFromMask(mask: Ip): number | null {
  const m = mask >>> 0;
  const inverted = ~m >>> 0;
  // A valid mask's inverse is of the form 0...01...1, i.e. inverted+1 is a power of two.
  if (((inverted + 1) & inverted) >>> 0 !== 0) return null;
  let prefix = 0;
  for (let bit = 31; bit >= 0; bit--) {
    if ((m >>> bit) & 1) prefix++;
    else break;
  }
  return prefix;
}

export function parseMask(text: string): number | null {
  const t = text.trim();
  if (t.startsWith('/')) return parsePrefix(t.slice(1));
  const ip = parseIp(t);
  return ip === null ? null : prefixFromMask(ip);
}

export function parsePrefix(text: string): number | null {
  if (!/^\d{1,2}$/.test(text.trim())) return null;
  const n = Number(text);
  return n >= 0 && n <= 32 ? n : null;
}

export interface Cidr {
  ip: Ip;
  prefix: number;
}

export function parseCidr(text: string): Cidr | null {
  const [ipText, prefixText, extra] = text.trim().split('/');
  if (extra !== undefined || ipText === undefined || prefixText === undefined) return null;
  const ip = parseIp(ipText);
  const prefix = parsePrefix(prefixText);
  if (ip === null || prefix === null) return null;
  return { ip, prefix };
}

export function formatCidr(ip: Ip, prefix: number): string {
  return `${formatIp(ip)}/${prefix}`;
}

export function networkOf(ip: Ip, prefix: number): Ip {
  return (ip & maskFromPrefix(prefix)) >>> 0;
}

export function broadcastOf(ip: Ip, prefix: number): Ip {
  return (networkOf(ip, prefix) | (~maskFromPrefix(prefix) >>> 0)) >>> 0;
}

export function inSubnet(ip: Ip, net: Ip, prefix: number): boolean {
  return networkOf(ip, prefix) === networkOf(net, prefix);
}

/** True if ip is a usable host address inside its subnet (not network or broadcast, for /0–/30). */
export function isUsableHost(ip: Ip, prefix: number): boolean {
  if (prefix >= 31) return true;
  return ip !== networkOf(ip, prefix) && ip !== broadcastOf(ip, prefix);
}

export function hostCount(prefix: number): number {
  if (prefix >= 32) return 1;
  if (prefix === 31) return 2;
  return 2 ** (32 - prefix) - 2;
}

export function isPrivate(ip: Ip): boolean {
  return (
    inSubnet(ip, 0x0a000000, 8) || // 10.0.0.0/8
    inSubnet(ip, 0xac100000, 12) || // 172.16.0.0/12
    inSubnet(ip, 0xc0a80000, 16) // 192.168.0.0/16
  );
}

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

export function parseMac(text: string): Mac | null {
  const t = text.trim().toLowerCase().replace(/-/g, ':');
  return MAC_RE.test(t) ? t : null;
}

/** Deterministic, locally-administered unicast MAC (02:...) from a counter. */
export function macFromCounter(n: number): Mac {
  const bytes = [0x02, 0x50, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
}
