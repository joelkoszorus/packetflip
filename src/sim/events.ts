import type { Frame, IpPacket } from './net/pdu';

export type DropReason =
  | 'link-down'
  | 'no-link'
  | 'congestion'
  | 'sim-overload'
  | 'l2-loop'
  | 'vlan-missing'
  | 'vlan-not-allowed'
  | 'tagged-on-access'
  | 'no-l3-interface'
  | 'no-ip'
  | 'no-gateway'
  | 'gateway-off-subnet'
  | 'arp-timeout'
  | 'arp-queue-full'
  | 'no-route'
  | 'ttl-expired'
  | 'not-a-router'
  | 'acl-deny'
  | 'firewall-deny'
  | 'nat-no-translation'
  | 'port-unreachable'
  | 'device-off'
  | 'bogon-source';

export const DROP_REASON_TEXT: Record<DropReason, string> = {
  'link-down': 'Cable or port is down',
  'no-link': 'Nothing is plugged into this port',
  congestion: 'Link queue full (congestion)',
  'sim-overload': 'Too many packets in flight',
  'l2-loop': 'Switching loop detected',
  'vlan-missing': 'VLAN does not exist on this switch',
  'vlan-not-allowed': 'VLAN not allowed on this trunk',
  'tagged-on-access': 'Tagged frame arrived on an access port',
  'no-l3-interface': 'No IP interface for this port/VLAN',
  'no-ip': 'Interface has no IP address',
  'no-gateway': 'No default gateway configured',
  'gateway-off-subnet': 'Default gateway is not in the local subnet',
  'arp-timeout': 'No ARP reply (host unreachable)',
  'arp-queue-full': 'Too many packets waiting for ARP',
  'no-route': 'No route to destination',
  'ttl-expired': 'TTL expired (possible routing loop)',
  'not-a-router': 'Host received a packet for someone else',
  'acl-deny': 'Blocked by access list',
  'firewall-deny': 'Blocked by firewall policy',
  'nat-no-translation': 'No NAT translation for reply',
  'port-unreachable': 'No service listening on that port',
  'device-off': 'Device is powered off',
  'bogon-source': 'ISP dropped a private source address (is NAT configured?)',
};

export interface Endpoint {
  device: string;
  port: number;
}

export type SimEvent =
  | { type: 'hop'; frame: Frame; link: string; from: Endpoint; to: Endpoint; start: number; end: number }
  | { type: 'deliver'; device: string; packet: IpPacket; time: number }
  | { type: 'drop'; device: string; frame?: Frame; packet?: IpPacket; reason: DropReason; time: number; detail?: string }
  | { type: 'log'; device: string; text: string; time: number }
  | { type: 'breach'; device: string; packet: IpPacket; time: number }
  | { type: 'topology'; time: number }
  | { type: 'config'; device: string; time: number };

export type SimEventType = SimEvent['type'];
type Listener = (ev: SimEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(ev: SimEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (err) {
        // A faulty subscriber (UI, renderer) must never break the simulation.
        console.error('sim listener failed', err);
      }
    }
  }
}
