/**
 * Text renderers for "show" commands and the running configuration.
 * Output is plain text only; the UI renders it as text nodes, never as HTML.
 */
import { formatIp, maskFromPrefix, type Ip } from '../sim/net/addr';
import type { Device } from '../sim/devices/device';
import { L3Node } from '../sim/devices/l3';
import { Router } from '../sim/devices/router';
import { Firewall } from '../sim/devices/firewall';
import { Switch } from '../sim/devices/switch';
import { Host } from '../sim/devices/host';
import { formatAclEntry, formatAddrMatch } from '../sim/services/acl';

const mask = (prefix: number) => formatIp(maskFromPrefix(prefix));
const pad = (s: string, n: number) => (s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length));

export function vlanListText(list: number[] | null): string {
  if (list === null) return 'all';
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const start = list[i]!;
    let end = start;
    while (list[i + 1] === end + 1) end = list[++i]!;
    out.push(start === end ? String(start) : `${start}-${end}`);
  }
  return out.join(',');
}

export function showIpInterfaceBrief(d: L3Node): string[] {
  const lines = [pad('Interface', 14) + pad('IP-Address', 17) + pad('Status', 8) + 'Protocol'];
  for (const i of d.interfaces) {
    const port = d.ports[i.port]!;
    const status = !i.enabled || !port.enabled ? 'admin-down' : port.link ? 'up' : 'down';
    const proto = d.portUp(i.port) && i.enabled ? 'up' : 'down';
    const ip = i.ip === null ? 'unassigned' : `${formatIp(i.ip)}/${i.prefix}`;
    lines.push(pad(i.name, 14) + pad(ip, 17) + pad(status, 8) + proto);
  }
  return lines;
}

export function showIpRoute(d: L3Node): string[] {
  const routes = d.routes().sort((a, b) => b.prefix - a.prefix || a.net - b.net);
  if (routes.length === 0) return ['Routing table is empty. Give an interface an IP address and plug it in.'];
  const lines = ['Codes: C - connected, S - static, S* - default', ''];
  for (const r of routes) {
    const code = r.kind === 'connected' ? 'C ' : r.kind === 'default' ? 'S*' : 'S ';
    const via = r.nextHop !== undefined ? `via ${formatIp(r.nextHop)}, ${r.iface.name}` : `is directly connected, ${r.iface.name}`;
    lines.push(`${code}  ${formatIp(r.net)}/${r.prefix} ${via}`);
  }
  return lines;
}

export function showArp(d: L3Node): string[] {
  const now = d.network.engine.now;
  const rows = [...d.arpCache].filter(([, e]) => e.expires > now);
  if (rows.length === 0) return ['ARP cache is empty.'];
  const lines = [pad('Address', 17) + pad('MAC', 19) + 'Interface'];
  for (const [key, e] of rows) {
    const ip = Number(key.split('|')[1]);
    lines.push(pad(formatIp(ip), 17) + pad(e.mac, 19) + e.iface);
  }
  return lines;
}

export function showMacTable(s: Switch): string[] {
  const rows = s.macEntries();
  if (rows.length === 0) return ['MAC address table is empty.'];
  return [pad('VLAN', 6) + pad('MAC Address', 19) + 'Port', ...rows.map((r) => pad(String(r.vlan), 6) + pad(r.mac, 19) + r.port)];
}

export function showVlanBrief(s: Switch): string[] {
  const lines = [pad('VLAN', 6) + pad('Name', 18) + 'Access ports'];
  for (const [id, name] of [...s.vlans].sort((a, b) => a[0] - b[0])) {
    const ports = s.ports.filter((p) => s.portConfig[p.index]!.mode === 'access' && s.portConfig[p.index]!.accessVlan === id).map((p) => p.name);
    lines.push(pad(String(id), 6) + pad(name, 18) + ports.join(', '));
  }
  const orphan = s.ports.filter((p) => s.portConfig[p.index]!.mode === 'access' && !s.vlans.has(s.portConfig[p.index]!.accessVlan));
  if (orphan.length) lines.push('', `! Warning: ${orphan.map((p) => p.name).join(', ')} assigned to a VLAN that does not exist (inactive).`);
  return lines;
}

export function showTrunks(s: Switch): string[] {
  const trunks = s.ports.filter((p) => s.portConfig[p.index]!.mode === 'trunk');
  if (trunks.length === 0) return ['No trunk ports.'];
  return [
    pad('Port', 9) + pad('Status', 9) + pad('Native', 8) + 'Allowed VLANs',
    ...trunks.map((p) => {
      const c = s.portConfig[p.index]!;
      return pad(p.name, 9) + pad(s.portUp(p.index) ? 'up' : 'down', 9) + pad(String(c.nativeVlan), 8) + vlanListText(c.allowedVlans);
    }),
  ];
}

export function showAccessLists(r: Router): string[] {
  if (r.acls.size === 0) return ['No access lists defined.'];
  const lines: string[] = [];
  for (const [name, entries] of r.acls) {
    const hits = r.aclHits.get(name) ?? [];
    lines.push(`Extended IP access list ${name}`);
    entries.forEach((e, i) => lines.push(`    ${(i + 1) * 10} ${formatAclEntry(e)}${hits[i] ? ` (${hits[i]} matches)` : ''}`));
    lines.push(`    (implicit) deny ip any any${hits[entries.length] ? ` (${hits[entries.length]} matches)` : ''}`);
  }
  return lines;
}

export function showNat(r: Router): string[] {
  const out = r.interfaces.find((i) => i.nat === 'outside');
  const lines = [`NAT is ${r.nat.enabled ? 'enabled' : 'disabled'}${out ? `, outside interface ${out.name}` : ''}`];
  for (const f of r.nat.forwards) lines.push(`  forward ${f.proto} ${f.outsidePort} -> ${formatIp(f.insideIp)}:${f.insidePort}`);
  const t = r.nat.translations();
  if (t.length === 0) lines.push('  No active translations.');
  else {
    lines.push(pad('  Proto', 9) + pad('Inside', 22) + 'Public port');
    for (const x of t) lines.push(pad(`  ${x.proto}`, 9) + pad(`${formatIp(x.inside)}:${x.insidePort}`, 22) + x.publicPort);
  }
  return lines;
}

export function showDhcpBindings(leases: Map<string, { mac: string; ip: Ip; pool: string }>): string[] {
  if (leases.size === 0) return ['No DHCP leases.'];
  return [pad('IP address', 17) + pad('MAC', 19) + 'Pool', ...[...leases.values()].map((l) => pad(formatIp(l.ip), 17) + pad(l.mac, 19) + l.pool)];
}

export function ipconfig(h: Host, all: boolean): string[] {
  const nic = h.nic;
  const port = h.ports[0]!;
  const lines = [`Ethernet adapter eth0${h.portUp(0) ? '' : ' (media disconnected)'}:`];
  lines.push(`   Addressing . . . . : ${h.dhcpEnabled ? `DHCP (${h.dhcpClient.phase})` : 'static'}`);
  lines.push(`   IPv4 address . . . : ${nic.ip === null ? '(none)' : formatIp(nic.ip)}`);
  lines.push(`   Subnet mask  . . . : ${mask(nic.prefix)} (/${nic.prefix})`);
  lines.push(`   Default gateway  . : ${h.gateway === null ? '(none)' : formatIp(h.gateway)}`);
  lines.push(`   DNS server . . . . : ${h.dns === null ? '(none)' : formatIp(h.dns)}`);
  if (all) {
    lines.push(`   Physical address . : ${port.mac}`);
    const svc = [h.http.enabled && 'web', h.dnsServer.enabled && 'dns', h.dhcpServer.enabled && 'dhcp'].filter(Boolean);
    lines.push(`   Services . . . . . : ${svc.length ? svc.join(', ') : '(none)'}`);
  }
  return lines;
}

/** The running configuration in NetOS syntax. Re-entering it rebuilds the same config. */
export function runningConfig(d: Device): string[] {
  const lines = [`hostname ${d.name.replace(/\s+/g, '-')}`, '!'];
  if (d instanceof Switch) {
    for (const [id, name] of [...d.vlans].sort((a, b) => a[0] - b[0])) {
      if (id === 1) continue;
      lines.push(`vlan ${id}`, ` name ${name}`, '!');
    }
    d.ports.forEach((p, i) => {
      const c = d.portConfig[i]!;
      const body: string[] = [];
      if (p.description) body.push(` description ${p.description}`);
      if (c.mode === 'trunk') {
        body.push(' switchport mode trunk');
        if (c.allowedVlans !== null) body.push(` switchport trunk allowed vlan ${vlanListText(c.allowedVlans)}`);
        if (c.nativeVlan !== 1) body.push(` switchport trunk native vlan ${c.nativeVlan}`);
      } else if (c.accessVlan !== 1) body.push(' switchport mode access', ` switchport access vlan ${c.accessVlan}`);
      if (!p.enabled) body.push(' shutdown');
      if (body.length) lines.push(`interface ${p.name}`, ...body, '!');
    });
  }
  if (d instanceof Router) {
    for (const i of d.interfaces) {
      const port = d.ports[i.port]!;
      const body: string[] = [];
      if (i.vlan === undefined && port.description) body.push(` description ${port.description}`);
      if (i.vlan !== undefined) body.push(` encapsulation dot1q ${i.vlan}`);
      if (i.ip !== null) body.push(` ip address ${formatIp(i.ip)} ${mask(i.prefix)}`);
      if (i.helper !== undefined) body.push(` ip helper-address ${formatIp(i.helper)}`);
      if (i.aclIn) body.push(` ip access-group ${i.aclIn} in`);
      if (i.aclOut) body.push(` ip access-group ${i.aclOut} out`);
      if (i.nat) body.push(` ip nat ${i.nat}`);
      if (!i.enabled || (i.vlan === undefined && !port.enabled)) body.push(' shutdown');
      if (body.length || i.vlan !== undefined) lines.push(`interface ${i.name}`, ...body, '!');
    }
    for (const r of d.staticRoutes) lines.push(`ip route ${formatIp(r.net)} ${mask(r.prefix)} ${formatIp(r.nextHop)}`);
    if (d.staticRoutes.length) lines.push('!');
    for (const [name, entries] of d.acls) {
      lines.push(`ip access-list extended ${name}`, ...entries.map((e) => ` ${formatAclEntry(e)}`), '!');
    }
    const dh = d.dhcp;
    for (const x of dh.excluded) lines.push(`ip dhcp excluded-address ${formatIp(x)}`);
    for (const p of dh.pools) {
      lines.push(`ip dhcp pool ${p.name}`, ` network ${formatIp(p.network)} ${mask(p.prefix)}`, ` range ${formatIp(p.start)} ${formatIp(p.end)}`);
      if (p.gateway !== null) lines.push(` default-router ${formatIp(p.gateway)}`);
      if (p.dns !== null) lines.push(` dns-server ${formatIp(p.dns)}`);
      lines.push('!');
    }
    if (dh.enabled) lines.push('service dhcp', '!');
    if (d.nat.enabled) lines.push('ip nat enable');
    for (const f of d.nat.forwards) lines.push(`ip nat forward ${f.proto} ${f.outsidePort} ${formatIp(f.insideIp)} ${f.insidePort}`);
    if (d instanceof Firewall) {
      for (const r of d.rules) {
        lines.push(`firewall allow ${r.from} ${r.to} ${r.proto} ${formatAddrMatch(r.dst)}${r.dstPort !== undefined ? ` ${r.dstPort}` : ''}`);
      }
    }
  }
  lines.push('end');
  return lines;
}
