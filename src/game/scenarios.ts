/**
 * The first five scenarios. Each ships a reference solution (used by tests and
 * by the "show me" hint) that is applied through the same CLI and API the
 * player uses.
 */
import { Network, Host, Router, Switch, Cloud, parseIp, inSubnet, CATALOG, CABLES, type DeviceKind } from '../sim';
import { Shell } from '../cli/shell';
import {
  canBrowse,
  canPing,
  cannotBrowse,
  cannotPing,
  getsDhcpLease,
  noBreach,
  predicate,
  visitorReaches,
  type Objective,
} from './objectives';

export interface Ticket {
  from: string;
  subject: string;
  body: string[];
}

export interface Scenario {
  id: string;
  number: number;
  title: string;
  concepts: string[];
  ticket: Ticket;
  budget: number;
  parSeconds: number;
  palette: DeviceKind[];
  setup(net: Network): void;
  objectives: Objective[];
  bestPractice: Objective[];
  hints: string[];
  solve(net: Network): void;
}

const ip = (t: string) => parseIp(t)!;

function place<T>(net: Network, kind: DeviceKind, name: string, x: number, z: number): T {
  return net.addDevice(kind, { name, position: { x, z } }) as T;
}

function wire(net: Network, a: string, ap: string, b: string, bp: string): void {
  const da = net.deviceByName(a)!;
  const db = net.deviceByName(b)!;
  net.connect({ device: da.id, port: da.portByName(ap)!.index }, { device: db.id, port: db.portByName(bp)!.index });
}

function staticHost(net: Network, name: string, addr: string, prefix: number, gw: string | null): void {
  net.deviceByName<Host>(name)!.setStatic(ip(addr), prefix, gw ? ip(gw) : null);
}

/** Type commands into a device's terminal (used by reference solutions). */
export function typeInto(net: Network, deviceName: string, lines: string[]): string[] {
  const out: string[] = [];
  const sh = new Shell(net.deviceByName(deviceName)!, (l) => out.push(...l));
  for (const l of lines) sh.execute(l);
  return out;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'first-day',
    number: 1,
    title: 'First Day',
    concepts: ['Cabling', 'Switching', 'IP addresses & subnet masks', 'ARP', 'Ping'],
    ticket: {
      from: 'Office manager',
      subject: 'New PCs need to talk to each other',
      body: [
        'Welcome aboard! Three new PCs arrived for the design team.',
        'Please connect them with a switch so they can share files.',
        'Use the 192.168.10.0/24 network (mask 255.255.255.0).',
      ],
    },
    budget: 100,
    parSeconds: 300,
    palette: ['switch'],
    setup(net) {
      place(net, 'pc', 'PC1', -5, 4);
      place(net, 'pc', 'PC2', 0, 5);
      place(net, 'pc', 'PC3', 5, 4);
    },
    objectives: [
      predicate('addr', 'All PCs have addresses in 192.168.10.0/24', (net) => {
        const bad = ['PC1', 'PC2', 'PC3'].filter((n) => {
          const h = net.deviceByName<Host>(n);
          return !h || h.nic.ip === null || !inSubnet(h.nic.ip, ip('192.168.10.0'), 24) || h.nic.prefix !== 24;
        });
        return [bad.length === 0, bad.length ? `Check ${bad.join(', ')}` : 'Addressing looks right'];
      }),
      canPing('PC1', 'PC2'),
      canPing('PC1', 'PC3'),
      canPing('PC2', 'PC3'),
    ],
    bestPractice: [
      predicate('tidy', 'Tidy build: one switch, three cables', (net) => [
        net.devices.size === 4 && net.links.size === 3,
        `${net.devices.size - 3} extra device(s), ${net.links.size} cable(s)`,
      ]),
    ],
    hints: [
      'Drag a Switch from the palette onto the floor.',
      'Use the Cable tool (C) to connect each PC to a free switch port.',
      'Select a PC and give it an address like 192.168.10.11 with mask 255.255.255.0. Each PC needs a different address.',
      'Use the Ping tool from PC1 to 192.168.10.12 to test.',
    ],
    solve(net) {
      place(net, 'switch', 'SW1', 0, 0);
      wire(net, 'PC1', 'eth0', 'SW1', 'port1');
      wire(net, 'PC2', 'eth0', 'SW1', 'port2');
      wire(net, 'PC3', 'eth0', 'SW1', 'port3');
      typeInto(net, 'PC1', ['ipconfig /static 192.168.10.11 255.255.255.0']);
      typeInto(net, 'PC2', ['ipconfig /static 192.168.10.12 255.255.255.0']);
      typeInto(net, 'PC3', ['ipconfig /static 192.168.10.13 255.255.255.0']);
    },
  },

  {
    id: 'two-floors',
    number: 2,
    title: 'Two Floors',
    concepts: ['Subnets', 'Routing', 'Default gateway'],
    ticket: {
      from: 'Facilities',
      subject: 'Floor 1 and Floor 2 cannot see each other',
      body: [
        'Each floor has its own switch and its own network:',
        'Floor 1 is 192.168.1.0/24, Floor 2 is 192.168.2.0/24.',
        'Connect the floors with a router so everyone can reach everyone.',
      ],
    },
    budget: 170,
    parSeconds: 420,
    palette: ['router'],
    setup(net) {
      place(net, 'switch', 'SW-F1', -6, 0);
      place(net, 'switch', 'SW-F2', 6, 0);
      place(net, 'pc', 'F1-PC1', -9, 5);
      place(net, 'pc', 'F1-PC2', -4, 5);
      place(net, 'pc', 'F2-PC1', 4, 5);
      place(net, 'pc', 'F2-PC2', 9, 5);
      wire(net, 'F1-PC1', 'eth0', 'SW-F1', 'port1');
      wire(net, 'F1-PC2', 'eth0', 'SW-F1', 'port2');
      wire(net, 'F2-PC1', 'eth0', 'SW-F2', 'port1');
      wire(net, 'F2-PC2', 'eth0', 'SW-F2', 'port2');
      staticHost(net, 'F1-PC1', '192.168.1.10', 24, null);
      staticHost(net, 'F1-PC2', '192.168.1.11', 24, null);
      staticHost(net, 'F2-PC1', '192.168.2.10', 24, null);
      staticHost(net, 'F2-PC2', '192.168.2.11', 24, null);
    },
    objectives: [canPing('F1-PC1', 'F2-PC1'), canPing('F2-PC2', 'F1-PC2'), canPing('F1-PC2', 'F2-PC2')],
    bestPractice: [
      predicate('gw-first', 'Gateways use the first address of each subnet (.1)', (net) => {
        const r = [...net.devices.values()].find((d) => d instanceof Router) as Router | undefined;
        const ips = r?.interfaces.map((i) => i.ip) ?? [];
        const ok = ips.includes(ip('192.168.1.1')) && ips.includes(ip('192.168.2.1'));
        return [ok, ok ? 'Router uses .1 on both floors' : 'Convention: put the router on .1'];
      }),
    ],
    hints: [
      'A router joins different subnets. Place one and cable it to a free port on each floor switch.',
      'Give each router interface an address in that floor\'s subnet, e.g. 192.168.1.1 and 192.168.2.1.',
      'Each PC needs a default gateway: the router address on its own floor.',
    ],
    solve(net) {
      place(net, 'router', 'R1', 0, -4);
      wire(net, 'SW-F1', 'port8', 'R1', 'ge0');
      wire(net, 'SW-F2', 'port8', 'R1', 'ge1');
      typeInto(net, 'R1', ['enable', 'configure terminal', 'interface ge0', 'ip address 192.168.1.1 255.255.255.0', 'interface ge1', 'ip address 192.168.2.1 255.255.255.0', 'end']);
      for (const [h, a, g] of [
        ['F1-PC1', '192.168.1.10', '192.168.1.1'],
        ['F1-PC2', '192.168.1.11', '192.168.1.1'],
        ['F2-PC1', '192.168.2.10', '192.168.2.1'],
        ['F2-PC2', '192.168.2.11', '192.168.2.1'],
      ] as const) typeInto(net, h, [`ipconfig /static ${a} 255.255.255.0 ${g}`]);
    },
  },

  {
    id: 'ticket-42',
    number: 3,
    title: 'Ticket #42: The Printer',
    concepts: ['Troubleshooting', 'Subnet masks', 'Default gateway', 'show commands'],
    ticket: {
      from: 'Sales & Accounting',
      subject: 'URGENT: nobody can print!',
      body: [
        'The printer was "reconfigured" by a visiting contractor last night.',
        'Now neither Sales nor Accounting can reach it.',
        'Do not change its address (192.168.5.250); everyone has it saved.',
      ],
    },
    budget: 0,
    parSeconds: 300,
    palette: [],
    setup(net) {
      place(net, 'router', 'R1', 0, -5);
      place(net, 'switch', 'SW-SALES', -6, 0);
      place(net, 'switch', 'SW-ACCT', 6, 0);
      place(net, 'pc', 'Sales-PC', -9, 5);
      place(net, 'printer', 'Printer', -3, 5);
      place(net, 'pc', 'Acct-PC', 6, 5);
      wire(net, 'Sales-PC', 'eth0', 'SW-SALES', 'port1');
      wire(net, 'Printer', 'eth0', 'SW-SALES', 'port2');
      wire(net, 'Acct-PC', 'eth0', 'SW-ACCT', 'port1');
      wire(net, 'SW-SALES', 'port8', 'R1', 'ge0');
      wire(net, 'SW-ACCT', 'port8', 'R1', 'ge1');
      typeInto(net, 'R1', ['en', 'conf t', 'int ge0', 'ip address 192.168.5.1 255.255.255.0', 'int ge1', 'ip address 10.20.0.1 255.255.255.0', 'end']);
      staticHost(net, 'Sales-PC', '192.168.5.10', 24, '192.168.5.1');
      staticHost(net, 'Acct-PC', '10.20.0.10', 24, '10.20.0.1');
      staticHost(net, 'Printer', '192.168.5.250', 28, '192.168.5.254'); // the contractor's mistakes
    },
    objectives: [canPing('Sales-PC', 'Printer'), canPing('Acct-PC', 'Printer')],
    bestPractice: [
      predicate('keep-ip', 'Printer kept its address 192.168.5.250', (net) => {
        const p = net.deviceByName<Host>('Printer');
        return [p?.nic.ip === ip('192.168.5.250'), 'Users keep their saved printer settings'];
      }),
    ],
    hints: [
      'Open the printer\'s terminal and run "ipconfig". Compare its mask and gateway with Sales-PC.',
      'A /28 mask (255.255.255.240) makes the printer think 192.168.5.10 is on another network.',
      'The router\'s address on this LAN is 192.168.5.1. That is the gateway the printer needs.',
    ],
    solve(net) {
      typeInto(net, 'Printer', ['ipconfig /static 192.168.5.250 255.255.255.0 192.168.5.1']);
    },
  },

  {
    id: 'guest-isolation',
    number: 4,
    title: 'Guest Isolation',
    concepts: ['VLANs', 'Trunks (802.1Q)', 'Router-on-a-stick', 'Access lists'],
    ticket: {
      from: 'Security officer',
      subject: 'Guests are on the same network as payroll!',
      body: [
        'Visitors plug laptops into the meeting-room ports on the same switch as staff.',
        'Put staff in VLAN 10 (10.0.10.0/24) and guests in VLAN 20 (10.0.20.0/24).',
        'Guests must still reach their gateway, but never the staff network.',
      ],
    },
    budget: 170,
    parSeconds: 900,
    palette: ['router'],
    setup(net) {
      place(net, 'switch', 'SW1', 0, 0);
      place(net, 'pc', 'Staff-PC', -8, 5);
      place<Host>(net, 'server', 'Payroll', -4, 5);
      place(net, 'laptop', 'Guest-1', 4, 5);
      place(net, 'laptop', 'Guest-2', 8, 5);
      wire(net, 'Staff-PC', 'eth0', 'SW1', 'port1');
      wire(net, 'Payroll', 'eth0', 'SW1', 'port2');
      wire(net, 'Guest-1', 'eth0', 'SW1', 'port5');
      wire(net, 'Guest-2', 'eth0', 'SW1', 'port6');
      staticHost(net, 'Staff-PC', '10.0.10.10', 24, '10.0.10.1');
      staticHost(net, 'Payroll', '10.0.10.20', 24, '10.0.10.1');
      staticHost(net, 'Guest-1', '10.0.20.10', 24, '10.0.20.1');
      staticHost(net, 'Guest-2', '10.0.20.11', 24, '10.0.20.1');
      const payroll = net.deviceByName<Host>('Payroll')!;
      payroll.http.enabled = true;
      payroll.http.title = 'Payroll portal';
    },
    objectives: [
      predicate('vlans', 'Staff and guest ports are in different VLANs', (net) => {
        const s = net.deviceByName<Switch>('SW1');
        if (!s) return [false, 'SW1 is missing'];
        const vlanOf = (n: string) => {
          const h = net.deviceByName(n);
          const link = h?.ports[0]?.link;
          const end = link ? (link.a.device === s.id ? link.a : link.b.device === s.id ? link.b : null) : null;
          return end ? s.portConfig[end.port]!.accessVlan : null;
        };
        const staff = ['Staff-PC', 'Payroll'].map(vlanOf);
        const guest = ['Guest-1', 'Guest-2'].map(vlanOf);
        const ok = staff.every((v) => v === 10) && guest.every((v) => v === 20);
        return [ok, ok ? 'VLAN 10 = staff, VLAN 20 = guests' : `Staff ports: ${staff.join('/')}, guest ports: ${guest.join('/')}`];
      }),
      canBrowse('Staff-PC', '10.0.10.20'),
      canPing('Guest-1', '10.0.20.1', 'Guests can reach their gateway'),
      cannotBrowse('Guest-1', '10.0.10.20', 'Guests cannot open the payroll portal'),
      cannotPing('Guest-2', 'Staff-PC', 'Guests cannot reach staff PCs'),
    ],
    bestPractice: [
      predicate('acl-near-source', 'Guest ACL is applied inbound on the guest gateway', (net) => {
        const r = [...net.devices.values()].find((d) => d instanceof Router) as Router | undefined;
        const gw = r?.interfaces.find((i) => i.ip === ip('10.0.20.1'));
        const ok = !!gw?.aclIn && !!r?.acls.get(gw.aclIn)?.length;
        return [ok, ok ? `ACL ${gw!.aclIn} filters guest traffic at the edge` : 'Filter traffic as close to its source as possible'];
      }),
    ],
    hints: [
      'On SW1 create VLAN 10 and VLAN 20, then set each port\'s access VLAN.',
      'Cable a router to a free switch port and make that switch port a trunk.',
      'On the router create subinterfaces ge0.10 (10.0.10.1) and ge0.20 (10.0.20.1).',
      'Routing now joins the VLANs. Add an ACL on ge0.20 (in) that denies 10.0.20.0/24 → 10.0.10.0/24 and permits the rest.',
    ],
    solve(net) {
      place(net, 'router', 'R1', 0, -5);
      wire(net, 'SW1', 'port8', 'R1', 'ge0');
      typeInto(net, 'SW1', ['en', 'conf t', 'vlan 10', 'name staff', 'vlan 20', 'name guest', 'int port1', 'sw acc vlan 10', 'int port2', 'sw acc vlan 10', 'int port5', 'sw acc vlan 20', 'int port6', 'sw acc vlan 20', 'int port8', 'sw mode trunk', 'end']);
      typeInto(net, 'R1', ['en', 'conf t', 'int ge0.10', 'ip address 10.0.10.1 255.255.255.0', 'int ge0.20', 'ip address 10.0.20.1 255.255.255.0', 'ip access-list extended GUEST-IN', 'deny ip 10.0.20.0/24 10.0.10.0/24', 'permit ip any any', 'int ge0.20', 'ip access-group GUEST-IN in', 'end']);
    },
  },

  {
    id: 'going-online',
    number: 5,
    title: 'Going Online',
    concepts: ['DHCP', 'DNS', 'NAT / PAT', 'Port forwarding', 'Default route'],
    ticket: {
      from: 'Shop owner',
      subject: 'Get us on the Internet (on a budget!)',
      body: [
        'Our ISP gave us 203.0.113.2/29; their router is 203.0.113.1.',
        'Office PCs should get addresses automatically and browse www.packetflip.test.',
        'Our web shop server (192.168.1.80) must be reachable from the Internet, and nothing else.',
      ],
    },
    budget: 165,
    parSeconds: 1200,
    palette: ['router', 'firewall'],
    setup(net) {
      place<Cloud>(net, 'cloud', 'ISP', 0, -9);
      place(net, 'switch', 'SW1', 0, 2);
      place(net, 'pc', 'Office-PC1', -7, 7);
      place(net, 'laptop', 'Office-PC2', -3, 7);
      place<Host>(net, 'server', 'Shop', 5, 7);
      wire(net, 'Office-PC1', 'eth0', 'SW1', 'port1');
      wire(net, 'Office-PC2', 'eth0', 'SW1', 'port2');
      wire(net, 'Shop', 'eth0', 'SW1', 'port3');
      staticHost(net, 'Shop', '192.168.1.80', 24, '192.168.1.1');
      const shop = net.deviceByName<Host>('Shop')!;
      shop.http.enabled = true;
      shop.http.title = 'Our online shop';
      for (const n of ['Office-PC1', 'Office-PC2']) net.deviceByName<Host>(n)!.dhcpEnabled = true;
    },
    objectives: [
      getsDhcpLease('Office-PC1', '192.168.1.0', 24),
      canBrowse('Office-PC1', 'www.packetflip.test'),
      visitorReaches('203.0.113.2'),
      noBreach('203.0.113.2'),
    ],
    bestPractice: [
      predicate('dhcp-safe', 'DHCP never hands out the gateway or the server address', (net) => {
        const r = [...net.devices.values()].find((d) => d instanceof Router) as Router | undefined;
        const pool = r?.dhcp.pools[0];
        if (!pool) return [false, 'No DHCP pool on the router'];
        const unsafe = [ip('192.168.1.1'), ip('192.168.1.80')].filter((a) => a >= pool.start && a <= pool.end && !r!.dhcp.excluded.includes(a));
        return [unsafe.length === 0, unsafe.length === 0 ? 'Pool avoids static addresses' : 'Pool overlaps a static address: use a range or excluded-address'];
      }),
    ],
    hints: [
      'Place a router between SW1 and the ISP. Give ge0 192.168.1.1/24 (LAN) and ge1 203.0.113.2/29 (WAN).',
      'Add a default route: ip route 0.0.0.0 0.0.0.0 203.0.113.1',
      'Create a DHCP pool for 192.168.1.0/24 with default-router 192.168.1.1 and dns-server 192.0.2.53 (the ISP resolver).',
      'Mark ge0 "ip nat inside", ge1 "ip nat outside", then "ip nat enable".',
      'Publish only the shop: ip nat forward tcp 80 192.168.1.80 80',
    ],
    solve(net) {
      place(net, 'router', 'EDGE', 0, -4);
      wire(net, 'SW1', 'port8', 'EDGE', 'ge0');
      wire(net, 'EDGE', 'ge1', 'ISP', 'wan0');
      typeInto(net, 'EDGE', [
        'en',
        'conf t',
        'int ge0',
        'ip address 192.168.1.1 255.255.255.0',
        'ip nat inside',
        'int ge1',
        'ip address 203.0.113.2 255.255.255.248',
        'ip nat outside',
        'exit',
        'ip route 0.0.0.0 0.0.0.0 203.0.113.1',
        'ip dhcp pool LAN',
        'network 192.168.1.0 255.255.255.0',
        'range 192.168.1.100 192.168.1.150',
        'default-router 192.168.1.1',
        'dns-server 192.0.2.53',
        'exit',
        'ip nat enable',
        'ip nat forward tcp 80 192.168.1.80 80',
        'end',
      ]);
    },
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** Money spent on top of the starting board. */
export function spentOn(net: Network, startDevices: Set<string>, startLinks: Set<string>): number {
  let total = 0;
  for (const d of net.devices.values()) if (!startDevices.has(d.id)) total += CATALOG[d.kind].cost;
  for (const l of net.links.values()) if (!startLinks.has(l.id)) total += CABLES[l.cable].cost;
  return total;
}

export interface StarResult {
  stars: number;
  completed: boolean;
  underBudget: boolean;
  underPar: boolean;
  bestPractice: boolean;
}

/** ★ complete · ★ under budget and par time · ★ best practice. */
export function scoreStars(completed: boolean, spent: number, budget: number, seconds: number, par: number, best: boolean): StarResult {
  const underBudget = spent <= budget;
  const underPar = seconds <= par;
  const stars = completed ? 1 + (underBudget && underPar ? 1 : 0) + (best ? 1 : 0) : 0;
  return { stars, completed, underBudget, underPar, bestPractice: best };
}
