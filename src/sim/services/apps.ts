/**
 * Application services and clients: DNS (udp/53), HTTP over simplified TCP (tcp/80),
 * and a UDP "media" sink used for VoIP-style flows.
 */
import { IP_BROADCAST, formatIp, parseIp, type Ip } from '../net/addr';
import type { AppPayload, IpPacket } from '../net/pdu';
import type { L3Interface, L3Node } from '../devices/l3';
import { LIMITS } from '../limits';

export const DNS_PORT = 53;
export const HTTP_PORT = 80;
export const MEDIA_PORT = 5004;
export const CLIENT_TIMEOUT_MS = 15_000;

export interface AppResult {
  ok: boolean;
  message: string;
}

const NAME_RE = /^(?=.{1,63}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function normalizeHostname(name: string): string | null {
  const n = name.trim().toLowerCase().replace(/\.$/, '');
  return NAME_RE.test(n) ? n : null;
}

export interface WebTarget {
  host: string;
  port: number;
  path: string;
}

/**
 * Parse what a player types into a browser: "10.0.0.5", "intranet.test",
 * "http://10.0.0.5", "http://shop.test:8080/cart". Returns an error message
 * string for anything else.
 */
export function parseWebTarget(text: string): WebTarget | string {
  let t = String(text).trim();
  if (t === '') return 'Enter a web address, e.g. http://10.0.0.5 or www.packetflip.test';
  if (t.length > 200) return 'That address is too long';
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(t);
  if (scheme) {
    const s = scheme[1]!.toLowerCase();
    if (s === 'https') return 'HTTPS (encrypted web) is not simulated yet. Use http:// instead';
    if (s !== 'http') return `Only web addresses (http://) can be browsed, not ${s}://`;
    t = t.slice(scheme[0].length);
  }
  let path = '/';
  const cut = t.search(/[/?#]/);
  if (cut >= 0) {
    path = t.slice(cut);
    t = t.slice(0, cut);
    if (!path.startsWith('/')) path = `/${path}`;
  }
  path = path.replace(/[^\x21-\x7e]/g, '').slice(0, 63) || '/';
  let port = HTTP_PORT;
  const withPort = /^(.+):(\d{1,5})$/.exec(t);
  if (withPort) {
    port = Number(withPort[2]);
    t = withPort[1]!;
    if (port < 1 || port > 65535) return 'Port must be between 1 and 65535';
  }
  const host = t.toLowerCase().replace(/\.$/, '');
  if (parseIp(host) === null && !normalizeHostname(host)) return `"${host.slice(0, 40)}" is not a valid IP address or hostname`;
  return { host, port, path };
}

// ---------------- DNS ----------------

export class DnsServer {
  enabled = true;
  readonly records = new Map<string, Ip>();

  constructor(private readonly node: L3Node) {}

  handle(packet: IpPacket): void {
    const l4 = packet.l4;
    if (!this.enabled || l4.proto !== 'udp' || l4.payload.app !== 'dns' || l4.payload.kind !== 'query') return;
    const q = l4.payload;
    const ip = this.records.get(q.name) ?? null;
    this.node.sendPacket(
      packet.src,
      { proto: 'udp', srcPort: DNS_PORT, dstPort: l4.srcPort, payload: { app: 'dns', kind: 'answer', id: q.id, name: q.name, ip } },
      { src: packet.dst },
    );
  }

  setRecord(name: string, ip: Ip): boolean {
    const n = normalizeHostname(name);
    if (!n || (this.records.size >= LIMITS.maxAclEntries && !this.records.has(n))) return false;
    this.records.set(n, ip);
    return true;
  }

  serialize() {
    return { enabled: this.enabled, records: [...this.records].map(([name, ip]) => ({ name, ip })) };
  }

  load(c: ReturnType<DnsServer['serialize']>): void {
    this.enabled = c.enabled;
    this.records.clear();
    for (const r of c.records) this.records.set(r.name, r.ip);
  }
}

let dnsQueryId = 1;

/** Resolve a hostname (or IP literal) using the given DNS server address. */
export function resolveName(
  node: L3Node,
  name: string,
  dnsServer: Ip | null,
  cb: (ip: Ip | null, message: string) => void,
  opts: { src?: Ip } = {},
): void {
  const literal = parseIp(name);
  if (literal !== null) return cb(literal, 'IP literal');
  const n = normalizeHostname(name);
  if (!n) return cb(null, `"${name.slice(0, 40)}" is not a valid hostname`);
  if (dnsServer === null) return cb(null, 'No DNS server configured');
  const port = node.allocPort();
  const id = dnsQueryId++;
  let done = false;
  const finish = (ip: Ip | null, msg: string) => {
    if (done) return;
    done = true;
    unbind();
    offFail();
    cb(ip, msg);
  };
  const unbind = node.bindL4('udp', port, (p) => {
    const l4 = p.l4;
    if (l4.proto === 'udp' && l4.payload.app === 'dns' && l4.payload.kind === 'answer' && l4.payload.id === id) {
      if (l4.payload.ip === null) finish(null, `DNS: ${n} not found (NXDOMAIN)`);
      else finish(l4.payload.ip, `DNS: ${n} is ${formatIp(l4.payload.ip)}`);
    }
  });
  const offFail = node.onLocalFailure((p, reason) => {
    if (p.l4.proto === 'udp' && p.l4.srcPort === port) finish(null, `DNS query failed: ${reason}`);
  });
  node.sendPacket(
    dnsServer,
    { proto: 'udp', srcPort: port, dstPort: DNS_PORT, payload: { app: 'dns', kind: 'query', id, name: n } },
    opts.src !== undefined ? { src: opts.src } : {},
  );
  node.network.engine.schedule(CLIENT_TIMEOUT_MS, () => finish(null, 'DNS: no answer (timed out)'), 'dns-timeout');
}

// ---------------- HTTP ----------------

export class HttpServer {
  enabled = true;
  title = 'It works!';
  requests = 0;

  constructor(private readonly node: L3Node) {}

  handle(packet: IpPacket): void {
    const l4 = packet.l4;
    if (l4.proto !== 'tcp') return;
    const reply = (flag: 'SYN-ACK' | 'PSH' | 'FIN' | 'RST', payload?: AppPayload) =>
      this.node.sendPacket(
        packet.src,
        { proto: 'tcp', srcPort: l4.dstPort, dstPort: l4.srcPort, flag, ...(payload ? { payload } : {}) },
        { src: packet.dst },
      );
    if (!this.enabled) {
      if (l4.flag !== 'RST') reply('RST');
      return;
    }
    if (l4.flag === 'SYN') reply('SYN-ACK');
    else if (l4.flag === 'PSH' && l4.payload?.app === 'http' && l4.payload.kind === 'request') {
      this.requests++;
      reply('PSH', { app: 'http', kind: 'response', status: 200, body: this.title });
    }
  }

  serialize() {
    return { enabled: this.enabled, title: this.title };
  }

  load(c: ReturnType<HttpServer['serialize']>): void {
    this.enabled = c.enabled;
    this.title = String(c.title).slice(0, 64);
  }
}

/** Fetch http://target/path: DNS lookup, TCP handshake, request, response. */
export function httpGet(
  node: L3Node,
  target: string,
  dnsServer: Ip | null,
  cb: (r: AppResult) => void,
  opts: { src?: Ip; hostile?: boolean; path?: string } = {},
): void {
  const web = parseWebTarget(target);
  if (typeof web === 'string') {
    cb({ ok: false, message: web });
    return;
  }
  resolveName(
    node,
    web.host,
    dnsServer,
    (ip, msg) => {
      if (ip === null) return cb({ ok: false, message: msg });
      const port = node.allocPort();
      let done = false;
      const finish = (r: AppResult) => {
        if (done) return;
        done = true;
        unbind();
        offIcmp();
        offFail();
        cb(r);
      };
      const send = (flag: 'SYN' | 'PSH' | 'FIN', payload?: AppPayload) =>
        node.sendPacket(
          ip,
          { proto: 'tcp', srcPort: port, dstPort: web.port, flag, ...(payload ? { payload } : {}) },
          { ...(opts.src !== undefined ? { src: opts.src } : {}), ...(opts.hostile ? { hostile: true } : {}) },
        );
      const unbind = node.bindL4('tcp', port, (p) => {
        const l4 = p.l4;
        if (l4.proto !== 'tcp') return;
        if (l4.flag === 'SYN-ACK') {
          send('PSH', { app: 'http', kind: 'request', host: web.host.slice(0, 63), path: opts.path ?? web.path });
        } else if (l4.flag === 'PSH' && l4.payload?.app === 'http' && l4.payload.kind === 'response') {
          send('FIN');
          finish({ ok: true, message: `HTTP ${l4.payload.status}: "${l4.payload.body}"` });
        } else if (l4.flag === 'RST') {
          finish({ ok: false, message: `Connection refused by ${formatIp(ip)}:${web.port} (no web server listening)` });
        }
      });
      const offIcmp = node.onIcmp((p) => {
        const l4 = p.l4;
        if (l4.proto === 'icmp' && l4.type !== 'echo-reply' && l4.type !== 'echo-request' && l4.original?.srcPort === port) {
          finish({ ok: false, message: `${l4.reason ?? 'Unreachable'} (from ${formatIp(p.src)})` });
        }
      });
      const offFail = node.onLocalFailure((p, reason) => {
        if (p.l4.proto === 'tcp' && p.l4.srcPort === port) finish({ ok: false, message: `Could not connect: ${reason}` });
      });
      send('SYN');
      node.network.engine.schedule(CLIENT_TIMEOUT_MS, () => finish({ ok: false, message: 'Connection timed out' }), 'http-timeout');
    },
    opts.src !== undefined ? { src: opts.src } : {},
  );
}

// ---------------- UDP media sink (VoIP) ----------------

export function handleMedia(node: L3Node, packet: IpPacket, _iface: L3Interface): void {
  // Sinks silently accept media. Delivery is counted via the 'deliver' event.
  void node;
  void packet;
}

/** Send a short burst of UDP media packets (e.g. a VoIP call). */
export function sendMedia(node: L3Node, dst: Ip, count = 5, intervalMs = 200, opts: { src?: Ip } = {}): number[] {
  const ids: number[] = [];
  const port = node.allocPort();
  for (let i = 0; i < count; i++) {
    node.network.engine.schedule(
      i * intervalMs,
      () => {
        const p = node.sendPacket(
          dst,
          { proto: 'udp', srcPort: port, dstPort: MEDIA_PORT, payload: { app: 'data', label: 'voice', bytes: 160 } },
          opts.src !== undefined ? { src: opts.src } : {},
        );
        ids.push(p.id);
      },
      'media',
    );
  }
  return ids;
}

export { IP_BROADCAST };
