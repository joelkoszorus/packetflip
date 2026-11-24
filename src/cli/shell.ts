/**
 * NetOS: the in-game command shell. An original command set that follows
 * common industry conventions (modes, abbreviations, show commands).
 * Every command edits the same device state as the GUI panels.
 */
import { formatIp, inSubnet, maskFromPrefix, networkOf, parseCidr, parseIp, type Ip } from '../sim/net/addr';
import type { Device } from '../sim/devices/device';
import { L3Node, type L3Interface } from '../sim/devices/l3';
import { Router } from '../sim/devices/router';
import { Firewall, type Zone } from '../sim/devices/firewall';
import { Switch } from '../sim/devices/switch';
import { Host } from '../sim/devices/host';
import { Cloud } from '../sim/devices/cloud';
import type { AclEntry, AclProto, AddrMatch } from '../sim/services/acl';
import type { DhcpPool } from '../sim/services/dhcp';
import { formatProbe, ping, traceroute } from '../sim/diag/ping';
import { LIMITS } from '../sim/limits';
import { parseWebTarget } from '../sim/services/apps';
import { match, nextOptions, parseSyntax, tokenize, type Args, type Candidate } from './parser';
import * as show from './show';

export type Mode = 'host' | 'exec' | 'priv' | 'config' | 'config-if' | 'config-vlan' | 'config-dhcp' | 'config-acl';
type Group = 'host' | 'router' | 'firewall' | 'switch' | 'cloud';

interface Ctx {
  sh: Shell;
  d: Device;
  args: Args;
}

interface CommandDef {
  modes: Mode[];
  groups: Group[];
  syntax: string;
  help: string;
  run: (ctx: Ctx) => string[] | void;
}

const L3: Group[] = ['router', 'firewall'];
const NET: Group[] = ['router', 'firewall', 'switch'];
const CONFIG_SUB: Mode[] = ['config-if', 'config-vlan', 'config-dhcp', 'config-acl'];

function groupOf(d: Device): Group {
  if (d instanceof Firewall) return 'firewall';
  if (d instanceof Router) return 'router';
  if (d instanceof Switch) return 'switch';
  if (d instanceof Cloud) return 'cloud';
  return 'host';
}

/** Resolve an interface name, allowing abbreviations like g0 → ge0, p1 → port1. */
export function resolvePortName(names: string[], input: string): string | null {
  const low = input.toLowerCase();
  const exact = names.find((n) => n.toLowerCase() === low);
  if (exact) return exact;
  const m = /^([a-z]+)([\d./]*)$/.exec(low);
  if (!m) return null;
  const [, letters, digits] = m;
  const hits = names.filter((n) => {
    const nm = /^([a-z]+)([\d./]*)$/.exec(n.toLowerCase());
    return nm && nm[1]!.startsWith(letters!) && nm[2] === digits;
  });
  return hits.length === 1 ? hits[0]! : null;
}

function parseAddrSpec(tokens: string[], i: number): { m: AddrMatch; next: number } | null {
  const t = tokens[i]?.toLowerCase();
  if (t === undefined) return null;
  if (t === 'any') return { m: { any: true }, next: i + 1 };
  if (t === 'host') {
    const ip = parseIp(tokens[i + 1] ?? '');
    return ip === null ? null : { m: { net: ip, prefix: 32 }, next: i + 2 };
  }
  const cidr = parseCidr(t);
  if (cidr) return { m: { net: networkOf(cidr.ip, cidr.prefix), prefix: cidr.prefix }, next: i + 1 };
  return null;
}

const PROTOS: AclProto[] = ['ip', 'icmp', 'tcp', 'udp'];
const ZONES: Zone[] = ['inside', 'dmz', 'outside'];

function parseAclLine(action: 'permit' | 'deny', spec: string): AclEntry | string {
  const t = tokenize(spec);
  const proto = t[0]?.toLowerCase() as AclProto;
  if (!PROTOS.includes(proto)) return '% Protocol must be ip, icmp, tcp or udp';
  const src = parseAddrSpec(t, 1);
  if (!src) return '% Bad source. Use: any | host A.B.C.D | A.B.C.D/len';
  const dst = parseAddrSpec(t, src.next);
  if (!dst) return '% Bad destination. Use: any | host A.B.C.D | A.B.C.D/len';
  const entry: AclEntry = { action, proto, src: src.m, dst: dst.m };
  if (t[dst.next] !== undefined) {
    if (t[dst.next]!.toLowerCase() !== 'eq' || !/^\d{1,5}$/.test(t[dst.next + 1] ?? '')) return '% Expected: eq <port>';
    if (proto !== 'tcp' && proto !== 'udp') return '% Ports only apply to tcp or udp';
    entry.dstPort = Number(t[dst.next + 1]);
    if (entry.dstPort > 65535) return '% Port out of range';
    if (t.length > dst.next + 2) return '% Unexpected input after port';
  }
  return entry;
}

const COMMANDS: CommandDef[] = [];
const def = (modes: Mode[], groups: Group[], syntax: string, help: string, run: CommandDef['run']) =>
  COMMANDS.push({ modes, groups, syntax, help, run });

// ---------------- navigation ----------------
def(['exec'], NET, 'enable', 'Enter privileged mode', ({ sh }) => void (sh.mode = 'priv'));
def(['priv'], NET, 'disable', 'Leave privileged mode', ({ sh }) => void (sh.mode = 'exec'));
def(['priv'], NET, 'configure terminal', 'Enter configuration mode', ({ sh }) => {
  sh.mode = 'config';
  return ['Enter configuration commands, one per line. End with "end".'];
});
def(['config', ...CONFIG_SUB], NET, 'end', 'Return to privileged mode', ({ sh }) => sh.leaveConfig());
def(['exec', 'priv', 'config', ...CONFIG_SUB], NET, 'exit', 'Go up one mode', ({ sh }) => sh.exitMode());
def(['host'], ['host', 'cloud'], 'exit', 'Close the terminal', () => ['(close the terminal panel to exit)']);
def(['host', 'exec', 'priv', 'config', ...CONFIG_SUB], ['host', 'router', 'firewall', 'switch', 'cloud'], 'help', 'Show help', ({ sh }) => sh.helpText());

// ---------------- diagnostics ----------------
const pingCmd = ({ sh, d, args }: Ctx) => sh.runPing(d as L3Node, args.target!, Number(args.count?.num ?? 4));
const traceCmd = ({ sh, d, args }: Ctx) => sh.runTrace(d as L3Node, args.target!);
def(['host'], ['host', 'cloud'], 'ping <target:target> <num:count?>', 'Send ICMP echo requests', pingCmd);
def(['exec', 'priv'], L3, 'ping <target:target> <num:count?>', 'Send ICMP echo requests', pingCmd);
def(['host'], ['host', 'cloud'], '{tracert|traceroute:cmd} <target:target>', 'Trace the route to a host', traceCmd);
def(['exec', 'priv'], L3, 'traceroute <target:target>', 'Trace the route to a host', traceCmd);

// ---------------- host commands ----------------
def(['host'], ['host'], 'ipconfig', 'Show IP configuration', ({ d }) => show.ipconfig(d as Host, false));
def(['host'], ['host'], 'ipconfig /all', 'Show full IP configuration', ({ d }) => show.ipconfig(d as Host, true));
def(['host'], ['host'], 'ipconfig /renew', 'Request an address via DHCP', ({ sh, d }) => {
  const h = d as Host;
  h.useDhcp((ok) => sh.print(ok ? show.ipconfig(h, false) : ['DHCP failed: no server answered. Using a self-assigned 169.254.x.x address.']));
  return ['Requesting an address via DHCP…'];
});
def(['host'], ['host'], 'ipconfig /release', 'Release the DHCP address', ({ d }) => {
  const h = d as Host;
  h.setStatic(null, h.nic.prefix, null);
  return ['Address released.'];
});
def(['host'], ['host'], 'ipconfig /static <ip:ip> <mask:mask> <ip:gw?>', 'Set a static address, mask and gateway', ({ d, args }) => {
  const h = d as Host;
  h.setStatic(args.ip!.ip!, args.mask!.prefix!, args.gw ? args.gw.ip! : null);
  return show.ipconfig(h, false);
});
def(['host'], ['host'], 'ipconfig /dns <ip:ip>', 'Set the DNS server', ({ d, args }) => {
  (d as Host).dns = args.ip!.ip!;
  d.network.configChanged(d.id);
  return [`DNS server set to ${args.ip!.text}`];
});
def(['host'], ['host'], 'nslookup <target:name>', 'Look up a hostname via DNS', ({ sh, d, args }) => {
  (d as Host).resolve(args.name!.text, (_ip, msg) => sh.print([msg]));
  return [`Querying ${args.name!.text}…`];
});
def(['host'], ['host'], '{browse|curl:cmd} <rest:url>', 'Fetch a web page, e.g. browse http://10.0.0.5', ({ sh, d, args }) => {
  const web = parseWebTarget(args.url!.text);
  if (typeof web === 'string') return [`% ${web}`];
  (d as Host).browse(args.url!.text, (r) => sh.print([r.ok ? `OK  ${r.message}` : `FAILED  ${r.message}`]));
  return [`Connecting to http://${web.host}${web.port === 80 ? '' : `:${web.port}`}${web.path} …`];
});
def(['host'], ['host'], 'arp -a', 'Show the ARP cache', ({ d }) => show.showArp(d as L3Node));

// ---------------- show ----------------
const SHOW_MODES: Mode[] = ['exec', 'priv'];
def(SHOW_MODES, L3, 'show ip interface brief', 'Interface IPs and status', ({ d }) => show.showIpInterfaceBrief(d as L3Node));
def(SHOW_MODES, L3, 'show ip route', 'Routing table', ({ d }) => show.showIpRoute(d as L3Node));
def(SHOW_MODES, L3, 'show arp', 'ARP cache', ({ d }) => show.showArp(d as L3Node));
def(SHOW_MODES, L3, 'show access-lists', 'Access lists and hit counts', ({ d }) => show.showAccessLists(d as Router));
def(SHOW_MODES, L3, 'show ip nat translations', 'NAT table', ({ d }) => show.showNat(d as Router));
def(SHOW_MODES, L3, 'show ip dhcp binding', 'DHCP leases', ({ d }) => show.showDhcpBindings((d as Router).dhcp.leases));
def(SHOW_MODES, ['switch'], 'show mac address-table', 'Learned MAC addresses', ({ d }) => show.showMacTable(d as Switch));
def(SHOW_MODES, ['switch'], 'show vlan brief', 'VLANs and access ports', ({ d }) => show.showVlanBrief(d as Switch));
def(SHOW_MODES, ['switch'], 'show interfaces trunk', 'Trunk ports', ({ d }) => show.showTrunks(d as Switch));
def(['priv'], NET, 'show running-config', 'Current configuration', ({ d }) => show.runningConfig(d));
def(['host'], ['cloud'], 'show ip route', 'Routing table', ({ d }) => show.showIpRoute(d as L3Node));
def(['priv'], L3, 'clear arp-cache', 'Flush the ARP cache', ({ d }) => {
  (d as L3Node).arpCache.clear();
  return ['ARP cache cleared.'];
});
def(['priv'], ['switch'], 'clear mac address-table', 'Flush learned MACs', ({ d }) => {
  (d as Switch).macTable.clear();
  return ['MAC address table cleared.'];
});
def(['priv'], NET, '{write|copy:cmd} <rest:rest?>', 'Save configuration', () => ['Configuration saved with your game.']);

// ---------------- global config ----------------
def(['config'], NET, 'hostname <word:name>', 'Rename this device', ({ d, args }) => {
  d.name = args.name!.text.slice(0, LIMITS.maxNameLength);
  d.network.topologyChanged();
});
def(['config'], NET, 'interface <iface:name>', 'Configure an interface', ({ sh, d, args }) => sh.enterInterface(d, args.name!.text));
def(['config'], NET, 'no interface <iface:name>', 'Delete a subinterface', ({ d, args }) => {
  if (!(d instanceof Router) || !d.removeInterface(args.name!.text)) return ['% Only subinterfaces (like ge0.10) can be deleted.'];
});
def(['config'], L3, 'ip route <ip:net> <mask:mask> <ip:hop>', 'Add a static route', ({ d, args }) => {
  const r = d as Router;
  if (!r.addStaticRoute({ net: networkOf(args.net!.ip!, args.mask!.prefix!), prefix: args.mask!.prefix!, nextHop: args.hop!.ip! }))
    return ['% Route table full.'];
  d.network.configChanged(d.id);
});
def(['config'], L3, 'no ip route <ip:net> <mask:mask> <ip:hop>', 'Remove a static route', ({ d, args }) => {
  if (!(d as Router).removeStaticRoute({ net: networkOf(args.net!.ip!, args.mask!.prefix!), prefix: args.mask!.prefix!, nextHop: args.hop!.ip! }))
    return ['% No such route.'];
});
def(['config'], ['switch'], 'vlan <vlan:id>', 'Create/configure a VLAN', ({ sh, d, args }) => {
  const s = d as Switch;
  const id = args.id!.num!;
  if (!s.vlans.has(id)) {
    if (s.vlans.size >= LIMITS.maxVlans) return ['% VLAN limit reached.'];
    s.vlans.set(id, `VLAN${String(id).padStart(4, '0')}`);
  }
  sh.mode = 'config-vlan';
  sh.vlan = id;
  d.network.configChanged(d.id);
});
def(['config'], ['switch'], 'no vlan <vlan:id>', 'Delete a VLAN', ({ d, args }) => {
  if (args.id!.num === 1) return ['% VLAN 1 cannot be deleted.'];
  (d as Switch).vlans.delete(args.id!.num!);
  d.network.configChanged(d.id);
});
def(['config-vlan'], ['switch'], 'name <word:name>', 'Name this VLAN', ({ sh, d, args }) => {
  (d as Switch).vlans.set(sh.vlan!, args.name!.text);
});
def(['config'], L3, 'ip dhcp pool <word:name>', 'Create/configure a DHCP pool', ({ sh, d, args }) => {
  const r = d as Router;
  let pool = r.dhcp.pools.find((p) => p.name === args.name!.text);
  if (!pool) {
    if (r.dhcp.pools.length >= 16) return ['% Too many pools.'];
    pool = { name: args.name!.text, network: 0, prefix: 24, start: 0, end: 0, gateway: null, dns: null };
    r.dhcp.pools.push(pool);
  }
  r.dhcp.enabled = true;
  sh.pool = pool;
  sh.mode = 'config-dhcp';
});
def(['config'], L3, 'no ip dhcp pool <word:name>', 'Delete a DHCP pool', ({ d, args }) => {
  const r = d as Router;
  r.dhcp.pools = r.dhcp.pools.filter((p) => p.name !== args.name!.text);
});
def(['config'], L3, 'service dhcp', 'Enable the DHCP server', ({ d }) => void ((d as Router).dhcp.enabled = true));
def(['config'], L3, 'no service dhcp', 'Disable the DHCP server', ({ d }) => void ((d as Router).dhcp.enabled = false));
def(['config'], L3, 'ip dhcp excluded-address <ip:a> <ip:b?>', 'Never lease these addresses', ({ d, args }) => {
  const r = d as Router;
  const a = args.a!.ip!;
  const b = args.b?.ip ?? a;
  if (b < a || b - a > 256) return ['% Range too large (max 256).'];
  for (let x = a; x <= b; x++) if (!r.dhcp.excluded.includes(x)) r.dhcp.excluded.push(x);
});
def(['config-dhcp'], L3, 'network <ip:net> <mask:mask>', 'Subnet served by this pool', ({ sh, args }) => {
  const p = sh.pool!;
  p.network = networkOf(args.net!.ip!, args.mask!.prefix!);
  p.prefix = args.mask!.prefix!;
  if (p.start === 0 || !inSubnet(p.start, p.network, p.prefix)) {
    p.start = p.network + 1;
    p.end = (p.network | (~maskFromPrefix(p.prefix) >>> 0)) - 1;
  }
});
def(['config-dhcp'], L3, 'range <ip:a> <ip:b>', 'First and last address to lease', ({ sh, args }) => {
  if (args.b!.ip! < args.a!.ip!) return ['% Range end is before start.'];
  sh.pool!.start = args.a!.ip!;
  sh.pool!.end = args.b!.ip!;
});
def(['config-dhcp'], L3, 'default-router <ip:gw>', 'Gateway handed to clients', ({ sh, args }) => void (sh.pool!.gateway = args.gw!.ip!));
def(['config-dhcp'], L3, 'dns-server <ip:dns>', 'DNS server handed to clients', ({ sh, args }) => void (sh.pool!.dns = args.dns!.ip!));
def(['config'], L3, 'ip access-list extended <word:name>', 'Create/edit an access list', ({ sh, d, args }) => {
  const r = d as Router;
  if (!r.acls.has(args.name!.text)) r.acls.set(args.name!.text, []);
  sh.acl = args.name!.text;
  sh.mode = 'config-acl';
});
def(['config'], L3, 'no ip access-list extended <word:name>', 'Delete an access list', ({ d, args }) => {
  (d as Router).acls.delete(args.name!.text);
});
def(['config-acl'], L3, '{permit|deny:action} <rest:spec>', 'Add a rule: <proto> <src> <dst> [eq <port>]', ({ sh, d, args }) => {
  const entry = parseAclLine(args.action!.text as 'permit' | 'deny', args.spec!.text);
  if (typeof entry === 'string') return [entry];
  if (!(d as Router).addAclEntry(sh.acl!, entry)) return ['% Access list is full.'];
});
def(['config'], L3, 'ip nat enable', 'Enable NAT overload (PAT)', ({ d }) => void ((d as Router).nat.enabled = true));
def(['config'], L3, 'no ip nat enable', 'Disable NAT', ({ d }) => void ((d as Router).nat.enabled = false));
def(['config'], L3, 'ip nat forward {tcp|udp:proto} <num:out> <ip:inside> <num:in>', 'Publish an inside service on the outside address', ({ d, args }) => {
  const r = d as Router;
  const proto = args.proto!.text as 'tcp' | 'udp';
  r.nat.forwards = r.nat.forwards.filter((f) => !(f.proto === proto && f.outsidePort === args.out!.num));
  r.nat.forwards.push({ proto, outsidePort: args.out!.num!, insideIp: args.inside!.ip!, insidePort: args.in!.num! });
});
def(['config'], L3, 'no ip nat forward {tcp|udp:proto} <num:out>', 'Remove a port forward', ({ d, args }) => {
  const r = d as Router;
  r.nat.forwards = r.nat.forwards.filter((f) => !(f.proto === args.proto!.text && f.outsidePort === args.out!.num));
});
def(['config'], ['firewall'], 'firewall allow {inside|dmz|outside:from} {inside|dmz|outside:to} <rest:spec>', 'Allow traffic: <proto> <dst> [port]', ({ d, args }) => {
  const t = tokenize(args.spec!.text);
  const proto = t[0]?.toLowerCase() as AclProto;
  if (!PROTOS.includes(proto)) return ['% Protocol must be ip, icmp, tcp or udp'];
  const dst = parseAddrSpec(t, 1);
  if (!dst) return ['% Bad destination. Use: any | host A.B.C.D | A.B.C.D/len'];
  const port = t[dst.next];
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return ['% Port must be a number'];
  const rule = { from: args.from!.text as Zone, to: args.to!.text as Zone, proto, dst: dst.m, ...(port ? { dstPort: Number(port) } : {}) };
  if (!ZONES.includes(rule.from) || !(d as Firewall).addRule(rule)) return ['% Could not add rule.'];
});
def(['config'], ['firewall'], 'no firewall allow', 'Remove all allow rules', ({ d }) => void ((d as Firewall).rules = []));

// ---------------- interface config ----------------
const ifCmd = (syntax: string, help: string, groups: Group[], run: (i: L3Interface | null, ctx: Ctx) => string[] | void) =>
  def(['config-if'], groups, syntax, help, (ctx) => run(ctx.sh.l3iface(), ctx));
ifCmd('ip address <ip:ip> <mask:mask>', 'Set the interface address', L3, (i, { args, d }) => {
  if (!i) return ['% Not an IP interface.'];
  const r = d as L3Node;
  const clash = r.interfaces.find((o) => o !== i && o.ip !== null && inSubnet(args.ip!.ip!, o.ip, o.prefix) && inSubnet(o.ip, args.ip!.ip!, args.mask!.prefix!));
  i.ip = args.ip!.ip!;
  i.prefix = args.mask!.prefix!;
  r.clearDynamicState();
  d.network.configChanged(d.id);
  if (clash) return [`% Warning: overlaps with ${clash.name} (${formatIp(clash.ip!)}/${clash.prefix})`];
});
ifCmd('no ip address', 'Remove the interface address', L3, (i, { d }) => {
  if (i) i.ip = null;
  d.network.configChanged(d.id);
});
ifCmd('encapsulation dot1q <vlan:vlan>', 'Set the subinterface VLAN tag', L3, (i, { args }) => {
  if (!i || i.vlan === undefined) return ['% Only subinterfaces (like ge0.10) carry a VLAN tag.'];
  i.vlan = args.vlan!.num!;
});
ifCmd('ip helper-address <ip:ip>', 'Relay DHCP broadcasts to a server', L3, (i, { args }) => void (i && (i.helper = args.ip!.ip!)));
ifCmd('no ip helper-address', 'Stop relaying DHCP', L3, (i) => void (i && delete i.helper));
ifCmd('ip access-group <word:name> {in|out:dir}', 'Apply an access list', L3, (i, { args }) => {
  if (!i) return;
  if (args.dir!.text === 'in') i.aclIn = args.name!.text;
  else i.aclOut = args.name!.text;
});
ifCmd('no ip access-group {in|out:dir}', 'Remove an access list', L3, (i, { args }) => {
  if (!i) return;
  if (args.dir!.text === 'in') delete i.aclIn;
  else delete i.aclOut;
});
ifCmd('ip nat {inside|outside:side}', 'Mark the interface for NAT', L3, (i, { args }) => void (i && (i.nat = args.side!.text as 'inside' | 'outside')));
ifCmd('no ip nat', 'Unmark the interface for NAT', L3, (i) => void (i && delete i.nat));
ifCmd('description <rest:text>', 'Describe this port', NET, (_i, { sh, args }) => {
  const port = sh.port();
  if (port) port.description = args.text!.text.slice(0, 48);
});
ifCmd('shutdown', 'Disable the interface', NET, (i, { sh, d }) => {
  if (i && i.vlan !== undefined) i.enabled = false;
  else {
    const p = sh.port();
    if (p) p.enabled = false;
  }
  d.network.topologyChanged();
});
ifCmd('no shutdown', 'Enable the interface', NET, (i, { sh, d }) => {
  if (i) i.enabled = true;
  const p = sh.port();
  if (p && (!i || i.vlan === undefined)) p.enabled = true;
  d.network.topologyChanged();
});
const swCmd = (syntax: string, help: string, run: (pc: Switch['portConfig'][number], ctx: Ctx) => string[] | void) =>
  def(['config-if'], ['switch'], syntax, help, (ctx) => {
    const pc = (ctx.d as Switch).portConfig[ctx.sh.portIndex!]!;
    const out = run(pc, ctx);
    ctx.d.clearDynamicState();
    ctx.d.network.configChanged(ctx.d.id);
    return out;
  });
swCmd('switchport mode {access|trunk:mode}', 'Access (one VLAN) or trunk (many, tagged)', (pc, { args }) => void (pc.mode = args.mode!.text as 'access' | 'trunk'));
swCmd('switchport access vlan <vlan:id>', 'VLAN for this access port', (pc, { d, args }) => {
  pc.accessVlan = args.id!.num!;
  if (!(d as Switch).vlans.has(pc.accessVlan)) return [`% VLAN ${pc.accessVlan} does not exist yet. Create it with "vlan ${pc.accessVlan}".`];
});
swCmd('switchport trunk allowed vlan <vlanlist:list>', 'VLANs carried on this trunk', (pc, { args }) => void (pc.allowedVlans = args.list!.list ?? null));
swCmd('switchport trunk native vlan <vlan:id>', 'Untagged VLAN on this trunk', (pc, { args }) => void (pc.nativeVlan = args.id!.num!));

// ---------------- the shell ----------------

const BANNER: Record<Group, string> = {
  host: 'Command prompt. Type "help" for commands.',
  router: 'NetOS router shell. Type "help" or "?" for commands.',
  firewall: 'NetOS firewall shell. Type "help" or "?" for commands.',
  switch: 'NetOS switch shell. Type "help" or "?" for commands.',
  cloud: 'ISP looking-glass. Type "help" for commands.',
};

export class Shell {
  mode: Mode;
  /** Context for sub-modes */
  ifaceName: string | null = null;
  portIndex: number | null = null;
  vlan: number | null = null;
  pool: DhcpPool | null = null;
  acl: string | null = null;
  readonly history: string[] = [];
  private readonly group: Group;

  constructor(
    readonly device: Device,
    private readonly output: (lines: string[]) => void,
  ) {
    this.group = groupOf(device);
    this.mode = this.group === 'host' || this.group === 'cloud' ? 'host' : 'exec';
  }

  get banner(): string {
    return BANNER[this.group];
  }

  print(lines: string[]): void {
    this.output(lines);
  }

  prompt(): string {
    const n = this.device.name;
    switch (this.mode) {
      case 'host':
        return `${n}:~$`;
      case 'exec':
        return `${n}>`;
      case 'priv':
        return `${n}#`;
      case 'config':
        return `${n}(config)#`;
      case 'config-if':
        return `${n}(config-if:${this.ifaceName})#`;
      case 'config-vlan':
        return `${n}(config-vlan:${this.vlan})#`;
      case 'config-dhcp':
        return `${n}(config-dhcp:${this.pool?.name})#`;
      case 'config-acl':
        return `${n}(config-acl:${this.acl})#`;
    }
  }

  private candidates(): Candidate<CommandDef>[] {
    return COMMANDS.filter((c) => c.modes.includes(this.mode) && c.groups.includes(this.group)).map((c) => ({
      def: c,
      elements: parseSyntax(c.syntax),
    }));
  }

  /** Run one line. Output is sent through the output callback. */
  execute(rawLine: string): void {
    // Strip ANSI escape sequences, then any remaining non-printable characters.
    // eslint-disable-next-line no-control-regex
    const line = rawLine.slice(0, 4096).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[^\x20-\x7e]/g, '').trim();
    if (!line) return;
    if (this.history[this.history.length - 1] !== line) this.history.push(line);
    if (this.history.length > 100) this.history.shift();
    if (line.endsWith('?')) {
      this.print(this.help(line.slice(0, -1)));
      return;
    }
    const tokens = tokenize(line);
    // "do <cmd>" runs an exec/priv command from config modes.
    if (tokens[0]?.toLowerCase() === 'do' && this.mode.startsWith('config')) {
      const saved = this.mode;
      this.mode = 'priv';
      this.execute(tokens.slice(1).join(' '));
      this.mode = saved;
      return;
    }
    const result = match(this.candidates(), tokens);
    if (!result.ok) {
      // Config sub-modes fall back to global config commands (like real gear).
      if (CONFIG_SUB.includes(this.mode)) {
        const saved = this.mode;
        this.mode = 'config';
        const global = match(this.candidates(), tokens);
        if (global.ok) {
          this.runDef(global.def, global.args);
          return;
        }
        this.mode = saved;
      }
      this.print([result.error || '% Unknown command. Type "help" or "?".']);
      return;
    }
    this.runDef(result.def, result.args);
  }

  private runDef(d: CommandDef, args: Args): void {
    try {
      const out = d.run({ sh: this, d: this.device, args });
      if (out && out.length) this.print(out);
    } catch (err) {
      console.error(err);
      this.print(['% Internal error running that command.']);
    }
  }

  help(prefix: string): string[] {
    const endsWithSpace = /\s$/.test(prefix) || prefix === '';
    const tokens = tokenize(prefix);
    const partial = endsWithSpace ? '' : tokens.pop() ?? '';
    const opts = nextOptions(this.candidates(), tokens, partial);
    if (opts.length === 0) return ['% No matching commands.'];
    if (tokens.length === 0 && !partial) {
      const firsts = new Map<string, string>();
      for (const c of this.candidates()) {
        const w = c.def.syntax.split(' ')[0]!.replace(/[{}]/g, '').split(':')[0]!;
        if (!firsts.has(w)) firsts.set(w, c.def.help);
      }
      return [...firsts].map(([w, h]) => `  ${w.padEnd(24)}${h}`);
    }
    return opts.map((o) => `  ${o.word.padEnd(24)}${o.help}`);
  }

  helpText(): string[] {
    return [`Commands available here (mode: ${this.mode}):`, ...this.help(''), '', 'Tip: abbreviate words ("sh ip int br"), use Tab to complete and "?" for options.'];
  }

  /** Tab completion: returns the completed line (or the original if ambiguous). */
  complete(line: string): { line: string; options: string[] } {
    const endsWithSpace = /\s$/.test(line);
    const tokens = tokenize(line);
    const partial = endsWithSpace ? '' : tokens.pop() ?? '';
    const opts = nextOptions(this.candidates(), tokens, partial).filter((o) => !o.word.startsWith('<'));
    if (opts.length === 1) return { line: [...tokens, opts[0]!.word].join(' ') + ' ', options: [] };
    return { line, options: opts.map((o) => o.word) };
  }

  leaveConfig(): void {
    this.mode = 'priv';
    this.ifaceName = null;
    this.portIndex = null;
    this.vlan = null;
    this.pool = null;
    this.acl = null;
  }

  exitMode(): string[] | void {
    if (CONFIG_SUB.includes(this.mode)) this.mode = 'config';
    else if (this.mode === 'config') this.leaveConfig();
    else if (this.mode === 'priv') this.mode = 'exec';
    else return ['(close the terminal panel to exit)'];
  }

  enterInterface(d: Device, name: string): string[] | void {
    const names = d instanceof L3Node ? d.interfaces.map((i) => i.name) : d.ports.map((p) => p.name);
    let resolved = resolvePortName(names, name);
    if (!resolved && d instanceof Router) {
      // Subinterface creation: <port>.<vlan>
      const m = /^(.+)\.(\d{1,4})$/.exec(name);
      const base = m ? resolvePortName(d.ports.map((p) => p.name), m[1]!) : null;
      if (m && base) {
        const sub = d.addSubinterface(d.portByName(base)!.index, Number(m[2]));
        if (!sub) return ['% Invalid VLAN number for subinterface.'];
        resolved = sub.name;
      }
    }
    if (!resolved) return [`% No interface named "${name}". Try: ${names.join(', ')}`];
    this.ifaceName = resolved;
    const iface = d instanceof L3Node ? d.ifaceByName(resolved) : undefined;
    this.portIndex = iface ? iface.port : d.portByName(resolved)!.index;
    this.mode = 'config-if';
  }

  l3iface(): L3Interface | null {
    return this.device instanceof L3Node && this.ifaceName ? this.device.ifaceByName(this.ifaceName) ?? null : null;
  }

  port() {
    return this.portIndex !== null ? this.device.ports[this.portIndex] : undefined;
  }

  // ---------------- async diagnostics ----------------

  private target(node: L3Node, arg: { ip?: Ip; text: string }, cb: (ip: Ip) => void): void {
    if (arg.ip !== undefined) return cb(arg.ip);
    if (node instanceof Host) {
      node.resolve(arg.text, (ip, msg) => (ip === null ? this.print([msg]) : cb(ip)));
    } else this.print(['% Routers ping by IP address.']);
  }

  runPing(node: L3Node, arg: { ip?: Ip; text: string }, count: number): string[] {
    const n = Math.max(1, Math.min(10, count || 4));
    this.target(node, arg, (dst) => {
      const s = ping(node, dst, { count: n });
      let shown = 0;
      s.onUpdate = () => {
        while (shown < s.results.length) this.print([formatProbe(s.results[shown++]!, 'ping')]);
        if (s.done) {
          const ok = s.results.filter((r) => r.kind === 'reply').length;
          this.print([`--- ${formatIp(dst)}: ${n} sent, ${ok} received, ${Math.round(((n - ok) / n) * 100)}% loss ---`]);
        }
      };
    });
    return [`Pinging ${arg.text} (${n} packets)…`];
  }

  runTrace(node: L3Node, arg: { ip?: Ip; text: string }): string[] {
    this.target(node, arg, (dst) => {
      const s = traceroute(node, dst);
      let shown = 0;
      s.onUpdate = () => {
        while (shown < s.results.length) this.print([formatProbe(s.results[shown++]!, 'trace')]);
        if (s.done) this.print(['Trace complete.']);
      };
    });
    return [`Tracing route to ${arg.text}…`];
  }
}
