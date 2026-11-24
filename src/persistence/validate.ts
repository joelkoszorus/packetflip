/**
 * Strict validator for untrusted save data (files, share links, localStorage).
 *
 * Security properties:
 *  - Input is parsed with JSON.parse only (never eval) and size-capped first.
 *  - Keys like __proto__ / constructor / prototype are rejected anywhere.
 *  - Output objects are rebuilt field-by-field from validated values, so no
 *    unexpected property (or prototype) from the input survives.
 *  - Counts and string lengths are capped (see LIMITS), so a hostile file
 *    cannot exhaust memory or hang the simulator.
 */
import { LIMITS } from '../sim/limits';
import { DEVICE_KINDS, CATALOG } from '../sim/catalog';
import type { DeviceKind } from '../sim/devices/device';
import type { CableType } from '../sim/link';

export class ValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NAME_RE = /^[\p{L}\p{N} ._-]{1,32}$/u;
const TEXT_RE = /^[\p{L}\p{N}\p{P}\p{Zs}\p{S}]*$/u;

/** JSON.parse with size cap and dangerous-key rejection. */
export function safeJsonParse(text: string, maxBytes: number = LIMITS.maxSaveBytes): unknown {
  if (typeof text !== 'string') throw new ValidationError('$', 'not text');
  if (text.length > maxBytes) throw new ValidationError('$', `file too large (max ${Math.round(maxBytes / 1024)} KB)`);
  try {
    return JSON.parse(text, (key, value) => {
      if (FORBIDDEN_KEYS.has(key)) throw new ValidationError('$', `forbidden key "${key}"`);
      return value;
    });
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError('$', 'not valid JSON');
  }
}

// ---------- primitive readers ----------
type Obj = Record<string, unknown>;

export function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ValidationError(path, 'expected an object');
  return v as Obj;
}
export function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) throw new ValidationError(path, 'expected a list');
  if (v.length > max) throw new ValidationError(path, `too many items (max ${max})`);
  return v;
}
export function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new ValidationError(path, `expected an integer ${min}..${max}`);
  return v;
}
export function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ValidationError(path, `expected a number ${min}..${max}`);
  return v;
}
export function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') throw new ValidationError(path, 'expected true/false');
  return v;
}
export function str(v: unknown, path: string, max: number, re: RegExp = TEXT_RE): string {
  if (typeof v !== 'string' || v.length > max || !re.test(v)) throw new ValidationError(path, `expected text (max ${max} chars)`);
  return v;
}
export function oneOf<T extends string>(v: unknown, path: string, options: readonly T[]): T {
  if (typeof v !== 'string' || !options.includes(v as T)) throw new ValidationError(path, `expected one of ${options.join(', ')}`);
  return v as T;
}
const ipv4 = (v: unknown, path: string) => int(v, path, 0, 0xffffffff);
const ipOrNull = (v: unknown, path: string) => (v === null ? null : ipv4(v, path));
const prefix = (v: unknown, path: string) => int(v, path, 0, 32);
const vlan = (v: unknown, path: string) => int(v, path, 1, 4094);
const port = (v: unknown, path: string) => int(v, path, 0, 65535);
const opt = <T>(o: Obj, key: string, read: (v: unknown, p: string) => T, path: string): T | undefined =>
  o[key] === undefined ? undefined : read(o[key], `${path}.${key}`);

// ---------- config readers ----------

function addrMatch(v: unknown, path: string) {
  const o = obj(v, path);
  if (o.any === true) return { any: true as const };
  return { net: ipv4(o.net, `${path}.net`), prefix: prefix(o.prefix, `${path}.prefix`) };
}

function aclEntry(v: unknown, path: string) {
  const o = obj(v, path);
  const e = {
    action: oneOf(o.action, `${path}.action`, ['permit', 'deny'] as const),
    proto: oneOf(o.proto, `${path}.proto`, ['ip', 'icmp', 'tcp', 'udp'] as const),
    src: addrMatch(o.src, `${path}.src`),
    dst: addrMatch(o.dst, `${path}.dst`),
  };
  const dp = opt(o, 'dstPort', port, path);
  return dp === undefined ? e : { ...e, dstPort: dp };
}

function dhcpConfig(v: unknown, path: string) {
  const o = obj(v, path);
  return {
    enabled: bool(o.enabled, `${path}.enabled`),
    pools: arr(o.pools, `${path}.pools`, 16).map((p, i) => {
      const q = obj(p, `${path}.pools[${i}]`);
      const pp = `${path}.pools[${i}]`;
      return {
        name: str(q.name, `${pp}.name`, 32, NAME_RE),
        network: ipv4(q.network, `${pp}.network`),
        prefix: prefix(q.prefix, `${pp}.prefix`),
        start: ipv4(q.start, `${pp}.start`),
        end: ipv4(q.end, `${pp}.end`),
        gateway: ipOrNull(q.gateway, `${pp}.gateway`),
        dns: ipOrNull(q.dns, `${pp}.dns`),
      };
    }),
    excluded: arr(o.excluded, `${path}.excluded`, 512).map((x, i) => ipv4(x, `${path}.excluded[${i}]`)),
  };
}

function l3iface(v: unknown, path: string, portCount: number) {
  const o = obj(v, path);
  const out: Record<string, unknown> = {
    name: str(o.name, `${path}.name`, 20, /^[A-Za-z0-9./-]{1,20}$/),
    port: int(o.port, `${path}.port`, 0, portCount - 1),
    ip: ipOrNull(o.ip, `${path}.ip`),
    prefix: prefix(o.prefix, `${path}.prefix`),
    enabled: bool(o.enabled, `${path}.enabled`),
  };
  const v1 = opt(o, 'vlan', vlan, path);
  if (v1 !== undefined) out.vlan = v1;
  const ai = opt(o, 'aclIn', (x, p) => str(x, p, 32, NAME_RE), path);
  if (ai !== undefined) out.aclIn = ai;
  const ao = opt(o, 'aclOut', (x, p) => str(x, p, 32, NAME_RE), path);
  if (ao !== undefined) out.aclOut = ao;
  const nat = opt(o, 'nat', (x, p) => oneOf(x, p, ['inside', 'outside'] as const), path);
  if (nat !== undefined) out.nat = nat;
  const helper = opt(o, 'helper', ipv4, path);
  if (helper !== undefined) out.helper = helper;
  const dhcp = opt(o, 'dhcp', bool, path);
  if (dhcp !== undefined) out.dhcp = dhcp;
  return out;
}

function staticRoute(v: unknown, path: string) {
  const o = obj(v, path);
  return { net: ipv4(o.net, `${path}.net`), prefix: prefix(o.prefix, `${path}.prefix`), nextHop: ipv4(o.nextHop, `${path}.nextHop`) };
}

function routerConfig(v: unknown, path: string, portCount: number) {
  const o = obj(v, path);
  const nat = obj(o.nat, `${path}.nat`);
  return {
    interfaces: arr(o.interfaces, `${path}.interfaces`, LIMITS.maxPortsPerDevice + LIMITS.maxVlans).map((x, i) =>
      l3iface(x, `${path}.interfaces[${i}]`, portCount),
    ),
    staticRoutes: arr(o.staticRoutes, `${path}.staticRoutes`, LIMITS.maxStaticRoutes).map((x, i) => staticRoute(x, `${path}.staticRoutes[${i}]`)),
    acls: arr(o.acls, `${path}.acls`, 16).map((x, i) => {
      const a = obj(x, `${path}.acls[${i}]`);
      return {
        name: str(a.name, `${path}.acls[${i}].name`, 32, NAME_RE),
        entries: arr(a.entries, `${path}.acls[${i}].entries`, LIMITS.maxAclEntries).map((e, j) => aclEntry(e, `${path}.acls[${i}].entries[${j}]`)),
      };
    }),
    nat: {
      enabled: bool(nat.enabled, `${path}.nat.enabled`),
      forwards: arr(nat.forwards, `${path}.nat.forwards`, 32).map((x, i) => {
        const f = obj(x, `${path}.nat.forwards[${i}]`);
        const fp = `${path}.nat.forwards[${i}]`;
        return {
          proto: oneOf(f.proto, `${fp}.proto`, ['tcp', 'udp'] as const),
          outsidePort: port(f.outsidePort, `${fp}.outsidePort`),
          insideIp: ipv4(f.insideIp, `${fp}.insideIp`),
          insidePort: port(f.insidePort, `${fp}.insidePort`),
        };
      }),
    },
    dhcp: dhcpConfig(o.dhcp, `${path}.dhcp`),
  };
}

const ZONES = ['inside', 'dmz', 'outside'] as const;

function firewallConfig(v: unknown, path: string, portCount: number) {
  const o = obj(v, path);
  return {
    ...routerConfig(v, path, portCount),
    rules: arr(o.rules, `${path}.rules`, LIMITS.maxAclEntries).map((x, i) => {
      const r = obj(x, `${path}.rules[${i}]`);
      const rp = `${path}.rules[${i}]`;
      const rule = {
        from: oneOf(r.from, `${rp}.from`, ZONES),
        to: oneOf(r.to, `${rp}.to`, ZONES),
        proto: oneOf(r.proto, `${rp}.proto`, ['ip', 'icmp', 'tcp', 'udp'] as const),
        dst: addrMatch(r.dst, `${rp}.dst`),
      };
      const dp = opt(r, 'dstPort', port, rp);
      return dp === undefined ? rule : { ...rule, dstPort: dp };
    }),
  };
}

function switchConfig(v: unknown, path: string, portCount: number) {
  const o = obj(v, path);
  const vlans = arr(o.vlans, `${path}.vlans`, LIMITS.maxVlans).map((x, i) => {
    const q = obj(x, `${path}.vlans[${i}]`);
    return { id: vlan(q.id, `${path}.vlans[${i}].id`), name: str(q.name, `${path}.vlans[${i}].name`, 32, NAME_RE) };
  });
  const ports = arr(o.ports, `${path}.ports`, portCount).map((x, i) => {
    const q = obj(x, `${path}.ports[${i}]`);
    const pp = `${path}.ports[${i}]`;
    return {
      mode: oneOf(q.mode, `${pp}.mode`, ['access', 'trunk'] as const),
      accessVlan: vlan(q.accessVlan, `${pp}.accessVlan`),
      nativeVlan: vlan(q.nativeVlan, `${pp}.nativeVlan`),
      allowedVlans: q.allowedVlans === null ? null : arr(q.allowedVlans, `${pp}.allowedVlans`, 4094).map((n, j) => vlan(n, `${pp}.allowedVlans[${j}]`)),
      enabled: bool(q.enabled, `${pp}.enabled`),
      description: str(q.description, `${pp}.description`, 48),
    };
  });
  return { vlans, ports };
}

function hostConfig(v: unknown, path: string) {
  const o = obj(v, path);
  const s = obj(o.services, `${path}.services`);
  const http = obj(s.http, `${path}.services.http`);
  const dns = obj(s.dns, `${path}.services.dns`);
  return {
    ip: ipOrNull(o.ip, `${path}.ip`),
    prefix: prefix(o.prefix, `${path}.prefix`),
    gateway: ipOrNull(o.gateway, `${path}.gateway`),
    dns: ipOrNull(o.dns, `${path}.dns`),
    dhcp: bool(o.dhcp, `${path}.dhcp`),
    services: {
      http: { enabled: bool(http.enabled, `${path}.services.http.enabled`), title: str(http.title, `${path}.services.http.title`, 64) },
      dns: {
        enabled: bool(dns.enabled, `${path}.services.dns.enabled`),
        records: arr(dns.records, `${path}.services.dns.records`, LIMITS.maxAclEntries).map((r, i) => {
          const q = obj(r, `${path}.services.dns.records[${i}]`);
          return {
            name: str(q.name, `${path}.services.dns.records[${i}].name`, 63, /^[a-z0-9.-]{1,63}$/),
            ip: ipv4(q.ip, `${path}.services.dns.records[${i}].ip`),
          };
        }),
      },
      dhcp: dhcpConfig(s.dhcp, `${path}.services.dhcp`),
    },
  };
}

function cloudConfig(v: unknown, path: string) {
  const o = obj(v, path);
  return {
    wanIp: ipv4(o.wanIp, `${path}.wanIp`),
    wanPrefix: prefix(o.wanPrefix, `${path}.wanPrefix`),
    customerRoutes: arr(o.customerRoutes, `${path}.customerRoutes`, 8).map((x, i) => staticRoute(x, `${path}.customerRoutes[${i}]`)),
  };
}

// ---------- top level ----------

export const SAVE_FORMAT = 'packet-flip';
export const SAVE_VERSION = 1;

export interface SavedDevice {
  id: string;
  kind: DeviceKind;
  name: string;
  x: number;
  z: number;
  powered: boolean;
  ports: { enabled: boolean; description: string }[];
  config: unknown;
}

export interface SavedLink {
  id: string;
  a: { device: string; port: number };
  b: { device: string; port: number };
  cable: CableType;
  up: boolean;
}

export interface SavedFlow {
  kind: 'ping' | 'web' | 'voip' | 'attack' | 'visit';
  from: string;
  to: string;
  everyMs: number;
  enabled: boolean;
}

export interface SaveFile {
  format: typeof SAVE_FORMAT;
  version: number;
  title: string;
  devices: SavedDevice[];
  links: SavedLink[];
  flows: SavedFlow[];
}

const ID_RE = /^[a-z]\d{1,6}$/;

export function validateSave(input: unknown): SaveFile {
  const o = obj(input, '$');
  if (o.format !== SAVE_FORMAT) throw new ValidationError('$.format', 'not a Packet Flip file');
  const version = int(o.version, '$.version', 1, 1000);
  if (version > SAVE_VERSION) throw new ValidationError('$.version', 'made by a newer version of Packet Flip');
  const ids = new Set<string>();
  const portCounts = new Map<string, number>();
  const devices = arr(o.devices, '$.devices', LIMITS.maxDevices).map((x, i): SavedDevice => {
    const p = `$.devices[${i}]`;
    const d = obj(x, p);
    const id = str(d.id, `${p}.id`, 8, ID_RE);
    if (ids.has(id)) throw new ValidationError(`${p}.id`, 'duplicate id');
    ids.add(id);
    const kind = oneOf(d.kind, `${p}.kind`, DEVICE_KINDS);
    const portCount = CATALOG[kind].ports.length;
    portCounts.set(id, portCount);
    const ports = arr(d.ports, `${p}.ports`, portCount).map((q, j) => {
      const pq = obj(q, `${p}.ports[${j}]`);
      return { enabled: bool(pq.enabled, `${p}.ports[${j}].enabled`), description: str(pq.description, `${p}.ports[${j}].description`, 48) };
    });
    let config: unknown;
    switch (kind) {
      case 'switch':
        config = switchConfig(d.config, `${p}.config`, portCount);
        break;
      case 'router':
        config = routerConfig(d.config, `${p}.config`, portCount);
        break;
      case 'firewall':
        config = firewallConfig(d.config, `${p}.config`, portCount);
        break;
      case 'cloud':
        config = cloudConfig(d.config, `${p}.config`);
        break;
      default:
        config = hostConfig(d.config, `${p}.config`);
    }
    return {
      id,
      kind,
      name: str(d.name, `${p}.name`, LIMITS.maxNameLength, NAME_RE),
      x: num(d.x, `${p}.x`, -500, 500),
      z: num(d.z, `${p}.z`, -500, 500),
      powered: bool(d.powered, `${p}.powered`),
      ports,
      config,
    };
  });
  const usedPorts = new Set<string>();
  const linkIds = new Set<string>();
  const links = arr(o.links, '$.links', LIMITS.maxLinks).map((x, i): SavedLink => {
    const p = `$.links[${i}]`;
    const l = obj(x, p);
    const id = str(l.id, `${p}.id`, 8, ID_RE);
    if (linkIds.has(id)) throw new ValidationError(`${p}.id`, 'duplicate id');
    linkIds.add(id);
    const end = (v: unknown, ep: string) => {
      const e = obj(v, ep);
      const device = str(e.device, `${ep}.device`, 8, ID_RE);
      if (!ids.has(device)) throw new ValidationError(`${ep}.device`, 'unknown device');
      const portIdx = int(e.port, `${ep}.port`, 0, portCounts.get(device)! - 1);
      const key = `${device}:${portIdx}`;
      if (usedPorts.has(key)) throw new ValidationError(ep, 'port used by two cables');
      usedPorts.add(key);
      return { device, port: portIdx };
    };
    const a = end(l.a, `${p}.a`);
    const b = end(l.b, `${p}.b`);
    if (a.device === b.device) throw new ValidationError(p, 'cable connects a device to itself');
    return { id, a, b, cable: oneOf(l.cable, `${p}.cable`, ['copper', 'fiber'] as const), up: bool(l.up, `${p}.up`) };
  });
  const flows = arr(o.flows ?? [], '$.flows', 64).map((x, i): SavedFlow => {
    const p = `$.flows[${i}]`;
    const f = obj(x, p);
    const from = str(f.from, `${p}.from`, 8, ID_RE);
    if (!ids.has(from)) throw new ValidationError(`${p}.from`, 'unknown device');
    return {
      kind: oneOf(f.kind, `${p}.kind`, ['ping', 'web', 'voip', 'attack', 'visit'] as const),
      from,
      to: str(f.to, `${p}.to`, 63, /^[A-Za-z0-9.-]{1,63}$/),
      everyMs: int(f.everyMs, `${p}.everyMs`, 1000, 120_000),
      enabled: bool(f.enabled, `${p}.enabled`),
    };
  });
  return {
    format: SAVE_FORMAT,
    version,
    title: o.title === undefined ? 'Untitled network' : str(o.title, '$.title', 64),
    devices,
    links,
    flows,
  };
}

export function parseSave(text: string): SaveFile {
  return validateSave(safeJsonParse(text));
}
