import type { DeviceKind } from './devices/device';

export interface CatalogEntry {
  kind: DeviceKind;
  label: string;
  category: 'end' | 'network' | 'security' | 'wan';
  cost: number;
  ports: string[];
  blurb: string;
}

const range = (prefix: string, n: number, start = 0) => Array.from({ length: n }, (_, i) => `${prefix}${i + start}`);

export const CATALOG: Record<DeviceKind, CatalogEntry> = {
  pc: { kind: 'pc', label: 'Desktop PC', category: 'end', cost: 40, ports: ['eth0'], blurb: 'A staff workstation.' },
  laptop: { kind: 'laptop', label: 'Laptop', category: 'end', cost: 50, ports: ['eth0'], blurb: 'A portable workstation.' },
  server: {
    kind: 'server',
    label: 'Server',
    category: 'end',
    cost: 120,
    ports: ['eth0'],
    blurb: 'Hosts services such as web, DNS and DHCP.',
  },
  printer: { kind: 'printer', label: 'Printer', category: 'end', cost: 30, ports: ['eth0'], blurb: 'Everyone needs to print.' },
  phone: { kind: 'phone', label: 'IP Phone', category: 'end', cost: 35, ports: ['eth0'], blurb: 'Voice over IP handset.' },
  switch: {
    kind: 'switch',
    label: 'Switch (8-port)',
    category: 'network',
    cost: 80,
    ports: range('port', 8, 1),
    blurb: 'Layer 2: learns MAC addresses, supports VLANs and trunks.',
  },
  router: {
    kind: 'router',
    label: 'Router',
    category: 'network',
    cost: 150,
    ports: range('ge', 4),
    blurb: 'Layer 3: routes between subnets. Supports subinterfaces, static routes, ACLs and NAT.',
  },
  firewall: {
    kind: 'firewall',
    label: 'Firewall',
    category: 'security',
    cost: 200,
    ports: ['inside', 'outside', 'dmz'],
    blurb: 'Stateful: allows replies to inside traffic, blocks unsolicited inbound traffic.',
  },
  cloud: {
    kind: 'cloud',
    label: 'ISP / Internet',
    category: 'wan',
    cost: 0,
    ports: ['wan0'],
    blurb: 'Your uplink to the (simulated) Internet.',
  },
};

export const DEVICE_KINDS = Object.keys(CATALOG) as DeviceKind[];
