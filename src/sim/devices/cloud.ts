/**
 * The ISP / "Internet" node. One cable, wan0, connects to the player's edge.
 * It answers for every public address that is not routed to the customer, and
 * hosts a few well-known (simulated) sites and a public DNS resolver.
 * All addresses come from documentation ranges (RFC 5737); nothing is real.
 */
import { L3Node, type L3Interface, type StaticRoute } from './l3';
import { formatIp, inSubnet, isPrivate, parseIp, type Ip } from '../net/addr';
import type { IpPacket } from '../net/pdu';
import type { DropReason } from '../events';
import { registerDeviceFactory } from '../network';
import { DNS_PORT, DnsServer, HTTP_PORT, HttpServer, httpGet, type AppResult } from '../services/apps';

const ip = (t: string) => parseIp(t)!;

export const INTERNET = {
  dns: ip('192.0.2.53'),
  web: ip('192.0.2.80'),
  mirror: ip('192.0.2.81'),
  visitor: ip('192.0.2.100'),
  attackerBase: ip('192.0.2.200'),
};

export interface CloudConfig {
  wanIp: Ip;
  wanPrefix: number;
  customerRoutes: StaticRoute[];
}

export class Cloud extends L3Node {
  readonly forwarding = false;
  dnsServer!: DnsServer;
  web!: HttpServer;
  attacksSent = 0;

  protected override onAttach(): void {
    this.interfaces = [{ name: 'wan0', port: 0, ip: ip('203.0.113.1'), prefix: 29, enabled: true }];
  }

  protected override installServices(): void {
    this.dnsServer = new DnsServer(this);
    this.dnsServer.setRecord('www.packetflip.test', INTERNET.web);
    this.dnsServer.setRecord('mirror.packetflip.test', INTERNET.mirror);
    this.dnsServer.setRecord('dns.packetflip.test', INTERNET.dns);
    this.web = new HttpServer(this);
    this.web.title = 'Welcome to the Internet';
    this.bindL4('udp', DNS_PORT, (p) => {
      if (p.dst === INTERNET.dns) this.dnsServer.handle(p);
    });
    this.bindL4('tcp', HTTP_PORT, (p) => {
      if (p.dst === INTERNET.web || p.dst === INTERNET.mirror) this.web.handle(p);
      else if (p.l4.proto === 'tcp' && p.l4.flag !== 'RST')
        this.sendPacket(p.src, { proto: 'tcp', srcPort: HTTP_PORT, dstPort: p.l4.srcPort, flag: 'RST' }, { src: p.dst });
    });
  }

  get wan(): L3Interface {
    return this.interfaces[0]!;
  }

  /** Customer-owned space: the WAN subnet plus any routed blocks. */
  private isCustomer(addr: Ip): boolean {
    const w = this.wan;
    if (w.ip !== null && inSubnet(addr, w.ip, w.prefix)) return addr !== w.ip;
    return this.staticRoutes.some((r) => inSubnet(addr, r.net, r.prefix));
  }

  /** "The Internet" owns every public address that is not the customer's. */
  override ownsIp(addr: Ip): boolean {
    if (this.wan.ip === addr) return true;
    return !isPrivate(addr) && addr !== 0 && addr !== 0xffffffff && !this.isCustomer(addr) && (addr >>> 24) !== 127;
  }

  protected override filterInbound(packet: IpPacket, _iface: L3Interface): IpPacket | DropReason {
    // Real ISPs drop RFC 1918 sources: the classic "forgot NAT" symptom.
    if (isPrivate(packet.src) && !this.isCustomer(packet.src)) return 'bogon-source';
    return packet;
  }

  /** Simulated attacker: unsolicited TCP SYNs to the target's ports. */
  attack(target: Ip, ports: number[] = [22, 23, 445, 3389]): void {
    for (const [i, port] of ports.entries()) {
      const src = INTERNET.attackerBase + ((this.attacksSent + i) % 50);
      this.sendPacket(target, { proto: 'tcp', srcPort: 40000 + i, dstPort: port, flag: 'SYN' }, { src, hostile: true });
    }
    this.attacksSent += ports.length;
  }

  /** A legitimate Internet visitor fetching http://target/. */
  visit(target: Ip, cb: (r: AppResult) => void): void {
    httpGet(this, formatIp(target), null, cb, { src: INTERNET.visitor });
  }

  serializeConfig(): CloudConfig {
    return { wanIp: this.wan.ip ?? ip('203.0.113.1'), wanPrefix: this.wan.prefix, customerRoutes: this.staticRoutes.map((r) => ({ ...r })) };
  }

  applyConfig(raw: unknown): void {
    const c = raw as CloudConfig;
    this.wan.ip = c.wanIp;
    this.wan.prefix = c.wanPrefix;
    this.staticRoutes = c.customerRoutes.map((r) => ({ ...r }));
  }
}

registerDeviceFactory('cloud', (id, _k, name, pos) => new Cloud(id, 'cloud', name, pos));
