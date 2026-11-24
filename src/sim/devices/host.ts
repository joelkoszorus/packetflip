import { L3Node, type L3Interface, type Route } from './l3';
import type { DeviceKind } from './device';
import { inSubnet, networkOf, type Ip } from '../net/addr';
import type { IpPacket } from '../net/pdu';
import type { DropReason } from '../events';
import { DHCP_SERVER_PORT, DhcpClient, DhcpServer, handleDhcpServerPort } from '../services/dhcp';
import {
  DNS_PORT,
  DnsServer,
  HTTP_PORT,
  HttpServer,
  MEDIA_PORT,
  httpGet,
  resolveName,
  type AppResult,
} from '../services/apps';

export type HostKind = Extract<DeviceKind, 'pc' | 'laptop' | 'server' | 'printer' | 'phone'>;

export interface HostConfig {
  ip: Ip | null;
  prefix: number;
  gateway: Ip | null;
  dns: Ip | null;
  dhcp: boolean;
  services: {
    http: ReturnType<HttpServer['serialize']>;
    dns: ReturnType<DnsServer['serialize']>;
    dhcp: ReturnType<DhcpServer['serialize']>;
  };
}

/** An end host with a single NIC. Does not forward packets. */
export class Host extends L3Node {
  readonly forwarding = false;
  gateway: Ip | null = null;
  dns: Ip | null = null;
  dhcpEnabled = false;
  http!: HttpServer;
  dnsServer!: DnsServer;
  dhcpServer!: DhcpServer;
  dhcpClient!: DhcpClient;

  constructor(id: string, kind: HostKind, name: string, position: { x: number; z: number }) {
    super(id, kind, name, position);
  }

  protected override onAttach(): void {
    this.interfaces = [{ name: 'eth0', port: 0, ip: null, prefix: 24, enabled: true }];
  }

  protected override installServices(): void {
    this.http = new HttpServer(this);
    this.dnsServer = new DnsServer(this);
    this.dhcpServer = new DhcpServer(this);
    this.dhcpClient = new DhcpClient(this);
    // Services start disabled; the player turns them on.
    this.http.enabled = false;
    this.dnsServer.enabled = false;
    this.dhcpServer.enabled = false;
    this.bindL4('tcp', HTTP_PORT, (p, i) => (this.http.enabled ? this.http.handle(p) : this.refuse(p, i)));
    this.bindL4('udp', DNS_PORT, (p, i) => (this.dnsServer.enabled ? this.dnsServer.handle(p) : this.refuse(p, i)));
    this.bindL4('udp', DHCP_SERVER_PORT, (p, i) => {
      if (this.dhcpServer.enabled) handleDhcpServerPort(this, this.dhcpServer, p, i);
    });
    this.bindL4('udp', MEDIA_PORT, () => {});
  }

  /** What a host does when nothing listens: TCP RST, or ICMP port unreachable for UDP. */
  private refuse(p: IpPacket, iface: L3Interface): void {
    const l4 = p.l4;
    if (l4.proto === 'tcp' && l4.flag !== 'RST') {
      this.sendPacket(p.src, { proto: 'tcp', srcPort: l4.dstPort, dstPort: l4.srcPort, flag: 'RST' }, { src: p.dst });
    } else if (l4.proto === 'udp') {
      this.sendIcmpError(p, 'dest-unreachable', iface, 'Port unreachable');
    }
  }

  get nic(): L3Interface {
    return this.interfaces[0]!;
  }

  override routes(): Route[] {
    const routes = super.routes();
    const connected = routes.find((r) => r.kind === 'connected');
    if (connected && this.gateway !== null && inSubnet(this.gateway, connected.net, connected.prefix)) {
      routes.push({ net: 0, prefix: 0, kind: 'default', iface: connected.iface, nextHop: this.gateway });
    }
    return routes;
  }

  protected override noRouteReason(dst: Ip): DropReason {
    const nic = this.nic;
    if (nic.ip === null) return 'no-ip';
    if (!this.portUp(nic.port)) return this.ports[0]?.link ? 'link-down' : 'no-link';
    if (inSubnet(dst, nic.ip, nic.prefix)) return 'no-route';
    if (this.gateway === null) return 'no-gateway';
    if (!inSubnet(this.gateway, nic.ip, nic.prefix)) return 'gateway-off-subnet';
    return 'no-route';
  }

  setStatic(ip: Ip | null, prefix: number, gateway: Ip | null = this.gateway): void {
    this.dhcpClient.stop();
    this.dhcpEnabled = false;
    this.nic.ip = ip;
    this.nic.prefix = prefix;
    this.nic.dhcp = false;
    this.gateway = gateway;
    this.clearDynamicState();
    this.net.configChanged(this.id);
  }

  /** Switch the NIC to DHCP and start a lease request. */
  useDhcp(onDone?: (ok: boolean) => void): void {
    this.dhcpEnabled = true;
    this.dhcpClient.start(onDone);
    this.net.configChanged(this.id);
  }

  resolve(name: string, cb: (ip: Ip | null, message: string) => void): void {
    resolveName(this, name, this.dns, cb);
  }

  browse(target: string, cb: (r: AppResult) => void): void {
    httpGet(this, target, this.dns, cb);
  }

  /** Network address of this host's subnet, or null. */
  subnet(): { net: Ip; prefix: number } | null {
    const nic = this.nic;
    return nic.ip === null ? null : { net: networkOf(nic.ip, nic.prefix), prefix: nic.prefix };
  }

  serializeConfig(): HostConfig {
    return {
      ip: this.dhcpEnabled ? null : this.nic.ip,
      prefix: this.nic.prefix,
      gateway: this.dhcpEnabled ? null : this.gateway,
      dns: this.dhcpEnabled ? null : this.dns,
      dhcp: this.dhcpEnabled,
      services: { http: this.http.serialize(), dns: this.dnsServer.serialize(), dhcp: this.dhcpServer.serialize() },
    };
  }

  applyConfig(raw: unknown): void {
    const c = raw as HostConfig;
    this.nic.ip = c.ip;
    this.nic.prefix = c.prefix;
    this.gateway = c.gateway;
    this.dns = c.dns;
    this.dhcpEnabled = c.dhcp;
    if (c.services) {
      this.http.load(c.services.http);
      this.dnsServer.load(c.services.dns);
      this.dhcpServer.load(c.services.dhcp);
    }
  }
}
