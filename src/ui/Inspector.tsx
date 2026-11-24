import { useState } from 'preact/hooks';
import {
  CATALOG,
  Cloud,
  Firewall,
  Host,
  INTERNET,
  L3Node,
  Router,
  Switch,
  formatIp,
  inSubnet,
  maskFromPrefix,
  networkOf,
  parseIp,
  parseCidr,
  type Device,
  type L3Interface,
  type AclEntry,
  type AddrMatch,
} from '../sim';
import { formatAclEntry, formatAddrMatch } from '../sim/services/acl';
import { parseWebTarget } from '../sim/services/apps';
import { parseVlanList } from '../cli/parser';
import { vlanListText } from '../cli/show';
import { store } from '../game/store';
import { NAME_RE, cx, ipOrEmpty, maskInput, submitOnEnter, useStore } from './hooks';
import { Terminal } from './Terminal';
import { ResizeHandle } from './Resize';

type Tab = 'overview' | 'config' | 'services' | 'terminal';

const ipText = (ip: number | null | undefined) => (ip === null || ip === undefined ? '' : formatIp(ip));
const touched = (d: Device) => {
  d.network.configChanged(d.id);
  store.changed();
};

export function Inspector() {
  const s = useStore();
  const [tab, setTab] = useState<Tab>('overview');
  const device = s.selected ? s.net.device(s.selected) : undefined;
  if (s.group.size > 1) return <GroupPanel />;
  if (!device) {
    return (
      <aside class="panel inspector empty">
        <ResizeHandle size="--right-w" label="inspector" />
        <h3>Inspector</h3>
        <p class="muted">Select a device to see its ports, configure it, or open its terminal.</p>
        <ul class="muted small">
          <li>
            <kbd>V</kbd> select & drag · <kbd>C</kbd> cable · <kbd>P</kbd> ping
          </li>
          <li>
            <kbd>U</kbd> unplug · <kbd>X</kbd> delete · <kbd>Space</kbd> pause
          </li>
        </ul>
      </aside>
    );
  }
  const isHost = device instanceof Host;
  const tabs: [Tab, string][] = [
    ['overview', 'Ports'],
    ['config', 'Config'],
    ...(isHost ? ([['services', 'Services']] as [Tab, string][]) : []),
    ['terminal', 'Terminal'],
  ];
  const active = tabs.some(([t]) => t === tab) ? tab : 'overview';
  return (
    <aside class="panel inspector">
      <ResizeHandle size="--right-w" label="inspector" />
      <DeviceHeader device={device} />
      <div class="tabs" role="tablist">
        {tabs.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={active === t} class={cx('tab', active === t && 'on')} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      <div class="tab-body">
        {active === 'overview' && <PortsView key={device.id} device={device} />}
        {active === 'config' && <ConfigView key={device.id} device={device} />}
        {active === 'services' && device instanceof Host && <ServicesView key={device.id} host={device} />}
        {active === 'terminal' && <Terminal key={device.id} device={device} />}
      </div>
    </aside>
  );
}

function GroupPanel() {
  const s = useStore();
  const ids = [...s.group].filter((id) => s.net.devices.has(id));
  const protectedCount = ids.filter((id) => s.run?.startDevices.has(id)).length;
  const deletable = ids.length - protectedCount;
  const internal = [...s.net.links.values()].filter((l) => s.group.has(l.a.device) && s.group.has(l.b.device)).length;
  return (
    <aside class="panel inspector">
      <ResizeHandle size="--right-w" label="inspector" />
      <div class="dev-head">
        <div class="dev-kind">Group</div>
        <h2 class="group-title">{ids.length} devices selected</h2>
        <p class="muted small">
          Drag any highlighted device to move them together. Cables stay plugged in{internal ? ` (${internal} between these devices)` : ''}.
        </p>
      </div>
      <ul class="group-list">
        {ids.map((id) => {
          const d = s.net.device(id)!;
          return (
            <li key={id} class={cx(id === s.selected && 'on')}>
              <button class="link plain" title="Inspect only this device" onClick={() => s.select(id)}>
                <span>{d.name}</span>
                <span class="muted small">{CATALOG[d.kind].label}</span>
              </button>
              <button class="link" aria-label={`Remove ${d.name} from the selection`} onClick={() => s.toggleInGroup(id)}>
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      <div class="row gap wrap">
        <button class="btn small" onClick={() => s.select(null)}>
          Clear selection
        </button>
        {deletable > 0 && (
          <button
            class="btn small danger"
            onClick={() => {
              if (window.confirm(`Delete ${deletable} device${deletable === 1 ? '' : 's'} and their cables?`)) s.deleteGroup();
            }}
          >
            Delete {deletable}
          </button>
        )}
      </div>
      <p class="muted small">
        <kbd>Shift</kbd>-click adds or removes a device · drag on empty floor to box-select · <kbd>Ctrl</kbd>+<kbd>A</kbd> selects all · <kbd>Esc</kbd> clears.
      </p>
    </aside>
  );
}

function DeviceHeader({ device }: { device: Device }) {
  const [name, setName] = useState(device.name);
  const [err, setErr] = useState('');
  const [forId, setForId] = useState(device.id);
  if (forId !== device.id) {
    setForId(device.id);
    setName(device.name);
    setErr('');
  }
  const commit = () => {
    const n = name.trim();
    if (n === device.name) return;
    if (!NAME_RE.test(n)) return setErr('Letters, digits, space . _ - (max 32)');
    const clash = device.network.deviceByName(n);
    if (clash && clash !== device) return setErr('Another device has that name');
    device.name = n;
    setErr('');
    device.network.topologyChanged();
  };
  const fixed = store.run?.startDevices.has(device.id);
  return (
    <div class="dev-head">
      <div class="dev-kind">{CATALOG[device.kind].label}</div>
      <input
        class="dev-name"
        value={name}
        maxLength={32}
        aria-label="Device name"
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {err && <div class="err">{err}</div>}
      <div class="row gap">
        <label class="toggle">
          <input
            type="checkbox"
            checked={device.powered}
            onChange={(e) => {
              device.powered = (e.target as HTMLInputElement).checked;
              device.clearDynamicState();
              device.network.topologyChanged();
            }}
          />
          Powered on
        </label>
        {!fixed && (
          <button class="btn danger small" onClick={() => store.deleteDevice(device.id)}>
            Delete
          </button>
        )}
      </div>
      <p class="muted small">{CATALOG[device.kind].blurb}</p>
    </div>
  );
}

function PortsView({ device }: { device: Device }) {
  const net = device.network;
  return (
    <table class="grid-table">
      <thead>
        <tr>
          <th>Port</th>
          <th>Status</th>
          <th>Connected to</th>
          <th>Info</th>
        </tr>
      </thead>
      <tbody>
        {device.ports.map((p) => {
          const peer = p.link?.peer(device.id, p.index);
          const other = peer ? net.device(peer.device) : undefined;
          const up = device.portUp(p.index);
          let info = '';
          if (device instanceof Switch) {
            const c = device.portConfig[p.index]!;
            info = c.mode === 'trunk' ? `trunk ${vlanListText(c.allowedVlans)}` : `VLAN ${c.accessVlan}`;
          } else if (device instanceof L3Node) {
            info = device.interfaces
              .filter((i) => i.port === p.index && i.ip !== null)
              .map((i) => `${i.vlan !== undefined ? `.${i.vlan} ` : ''}${formatIp(i.ip!)}/${i.prefix}`)
              .join(', ');
          }
          return (
            <tr key={p.index}>
              <td class="data">{p.name}</td>
              <td>
                <span class={cx('dot', up ? 'ok' : p.enabled ? 'off' : 'bad')} />
                {up ? 'up' : !p.enabled ? 'shut' : p.link ? 'down' : 'free'}
              </td>
              <td>{other ? `${other.name} (${other.ports[peer!.port]?.name})` : '—'}</td>
              <td class="data small">{info}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ConfigView({ device }: { device: Device }) {
  if (device instanceof Host) return <HostConfig host={device} />;
  if (device instanceof Switch) return <SwitchConfig sw={device} />;
  if (device instanceof Cloud) return <CloudConfig cloud={device} />;
  if (device instanceof Router) return <RouterConfig router={device} />;
  return null;
}

// ---------------- Host ----------------

function HostConfig({ host }: { host: Host }) {
  const nic = host.nic;
  const [mode, setMode] = useState<'static' | 'dhcp'>(host.dhcpEnabled ? 'dhcp' : 'static');
  const [ip, setIp] = useState(ipText(nic.ip));
  const [mask, setMask] = useState(formatIp(maskFromPrefix(nic.prefix)));
  const [gw, setGw] = useState(ipText(host.gateway));
  const [dns, setDns] = useState(ipText(host.dns));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [target, setTarget] = useState('');

  const apply = () => {
    const d = ipOrEmpty(dns);
    if (!d.ok) return setMsg({ ok: false, text: 'DNS server is not a valid IPv4 address' });
    if (mode === 'dhcp') {
      host.useDhcp((ok) => setMsg({ ok, text: ok ? `Leased ${ipText(host.nic.ip)}` : 'No DHCP server answered → 169.254.x.x' }));
      setMsg({ ok: true, text: 'Requesting an address…' });
      return;
    }
    const a = ipOrEmpty(ip);
    const m = maskInput(mask);
    const g = ipOrEmpty(gw);
    if (!a.ok) return setMsg({ ok: false, text: 'IP address is not valid (example: 192.168.1.10)' });
    if (m === null) return setMsg({ ok: false, text: 'Mask is not valid (example: 255.255.255.0 or 24)' });
    if (!g.ok) return setMsg({ ok: false, text: 'Gateway is not a valid IPv4 address' });
    host.setStatic(a.ip, m, g.ip);
    host.dns = d.ip;
    touched(host);
    if (a.ip !== null && g.ip !== null && !inSubnet(g.ip, a.ip, m)) {
      return setMsg({ ok: false, text: `Saved, but the gateway is outside ${formatIp(networkOf(a.ip, m))}/${m}: the host cannot reach it.` });
    }
    setMsg({ ok: true, text: 'Saved.' });
  };

  return (
    <div class="form" data-submit-scope>
      <div class="seg">
        <button class={cx(mode === 'static' && 'on')} onClick={() => setMode('static')}>
          Static
        </button>
        <button class={cx(mode === 'dhcp' && 'on')} onClick={() => setMode('dhcp')}>
          DHCP
        </button>
      </div>
      {mode === 'static' ? (
        <>
          <Field label="IP address" value={ip} onInput={setIp} placeholder="192.168.1.10" />
          <Field label="Subnet mask" value={mask} onInput={setMask} placeholder="255.255.255.0 or 24" />
          <Field label="Default gateway" value={gw} onInput={setGw} placeholder="192.168.1.1" />
        </>
      ) : (
        <p class="muted small">
          Current lease: {ipText(nic.ip) || 'none'} ({host.dhcpClient.phase})
        </p>
      )}
      <Field label="DNS server" value={dns} onInput={setDns} placeholder={formatIp(INTERNET.dns)} />
      <button class="btn primary" data-submit onClick={apply}>
        {mode === 'dhcp' ? 'Request address' : 'Apply'}
      </button>
      {msg && <div class={msg.ok ? 'okmsg' : 'err'}>{msg.text}</div>}
      <hr />
      <h4>Quick test</h4>
      <div class="row gap" data-submit-scope>
        <input
          class="input"
          value={target}
          maxLength={63}
          placeholder="10.0.0.5 or http://site.test"
          aria-label="Test target"
          onInput={(e) => setTarget((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            // Enter: a URL (scheme or path) opens it in the browser, anything else is pinged.
            const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\/|\//i.test(target.trim());
            if (e.key === 'Enter' && looksLikeUrl) {
              e.stopPropagation();
              e.preventDefault();
              (e.currentTarget as HTMLElement).closest('[data-submit-scope]')?.querySelector<HTMLButtonElement>('[data-browse]')?.click();
            } else submitOnEnter(e);
          }}
        />
        <button
          class="btn small"
          data-submit
          onClick={() => {
            // Accept a pasted URL too: ping its host part.
            const web = parseWebTarget(target);
            if (typeof web === 'string') return store.pushLog('bad', `${host.name}: ${web}`, host.id);
            host.resolve(web.host, (dst, m) => {
              if (dst === null) store.pushLog('bad', `${host.name}: ${m}`, host.id);
              else store.runPingFrom(host, dst, web.host);
            });
          }}
        >
          Ping
        </button>
        <button
          class="btn small"
          data-browse
          onClick={() => {
            const web = parseWebTarget(target);
            if (typeof web === 'string') return store.pushLog('bad', `${host.name}: ${web}`, host.id);
            const url = `http://${web.host}${web.port === 80 ? '' : `:${web.port}`}${web.path}`;
            store.info(`${host.name} → opening ${url}…`);
            host.browse(target, (r) => store.pushLog(r.ok ? 'ok' : 'bad', `${host.name} → ${url}: ${r.message}`, host.id));
          }}
        >
          Browse
        </button>
      </div>
    </div>
  );
}

function ServicesView({ host }: { host: Host }) {
  const [title, setTitle] = useState(host.http.title);
  const [recName, setRecName] = useState('');
  const [recIp, setRecIp] = useState('');
  const [err, setErr] = useState('');
  const pool = host.dhcpServer.pools[0];
  const [poolNet, setPoolNet] = useState(pool ? `${formatIp(pool.network)}/${pool.prefix}` : '');
  const [poolStart, setPoolStart] = useState(pool ? formatIp(pool.start) : '');
  const [poolEnd, setPoolEnd] = useState(pool ? formatIp(pool.end) : '');
  const [poolGw, setPoolGw] = useState(ipText(pool?.gateway));
  const [poolDns, setPoolDns] = useState(ipText(pool?.dns));
  return (
    <div class="form">
      <h4>
        <label class="toggle">
          <input type="checkbox" checked={host.http.enabled} onChange={(e) => ((host.http.enabled = (e.target as HTMLInputElement).checked), touched(host))} />
          Web server (TCP 80)
        </label>
      </h4>
      <Field label="Page title" value={title} onInput={setTitle} onBlur={() => ((host.http.title = title.slice(0, 64)), touched(host))} />
      <p class="muted small">{host.http.requests} requests served</p>
      <hr />
      <h4>
        <label class="toggle">
          <input type="checkbox" checked={host.dnsServer.enabled} onChange={(e) => ((host.dnsServer.enabled = (e.target as HTMLInputElement).checked), touched(host))} />
          DNS server (UDP 53)
        </label>
      </h4>
      <ul class="list">
        {[...host.dnsServer.records].map(([n, ip]) => (
          <li key={n}>
            <span class="data">{n}</span> → <span class="data">{formatIp(ip)}</span>
            <button class="link" onClick={() => (host.dnsServer.records.delete(n), touched(host))}>
              remove
            </button>
          </li>
        ))}
      </ul>
      <div class="row gap" data-submit-scope>
        <input class="input" placeholder="name.office.test" value={recName} maxLength={63} onInput={(e) => setRecName((e.target as HTMLInputElement).value)} onKeyDown={submitOnEnter} />
        <input class="input narrow" placeholder="10.0.0.5" value={recIp} maxLength={15} onInput={(e) => setRecIp((e.target as HTMLInputElement).value)} onKeyDown={submitOnEnter} />
        <button
          class="btn small"
          data-submit
          onClick={() => {
            const ip = parseIp(recIp);
            if (ip === null || !host.dnsServer.setRecord(recName, ip)) return setErr('Enter a hostname like files.office.test and an IPv4 address');
            setErr('');
            setRecName('');
            setRecIp('');
            touched(host);
          }}
        >
          Add
        </button>
      </div>
      <hr />
      <h4>
        <label class="toggle">
          <input type="checkbox" checked={host.dhcpServer.enabled} onChange={(e) => ((host.dhcpServer.enabled = (e.target as HTMLInputElement).checked), touched(host))} />
          DHCP server (UDP 67)
        </label>
      </h4>
      <div data-submit-scope>
      <Field label="Network (CIDR)" value={poolNet} onInput={setPoolNet} placeholder="192.168.1.0/24" />
      <div class="row gap">
        <Field label="First" value={poolStart} onInput={setPoolStart} placeholder=".100" />
        <Field label="Last" value={poolEnd} onInput={setPoolEnd} placeholder=".150" />
      </div>
      <div class="row gap">
        <Field label="Gateway" value={poolGw} onInput={setPoolGw} />
        <Field label="DNS" value={poolDns} onInput={setPoolDns} />
      </div>
      <button
        class="btn small"
        data-submit
        onClick={() => {
          const c = parseCidr(poolNet);
          const a = parseIp(poolStart);
          const b = parseIp(poolEnd);
          const g = ipOrEmpty(poolGw);
          const d = ipOrEmpty(poolDns);
          if (!c || a === null || b === null || b < a || !g.ok || !d.ok) return setErr('Check the pool: network like 192.168.1.0/24 and a first ≤ last address');
          if (!inSubnet(a, c.ip, c.prefix) || !inSubnet(b, c.ip, c.prefix)) return setErr('The range must be inside the network');
          host.dhcpServer.pools = [{ name: 'POOL', network: networkOf(c.ip, c.prefix), prefix: c.prefix, start: a, end: b, gateway: g.ip, dns: d.ip }];
          host.dhcpServer.enabled = true;
          setErr('');
          touched(host);
        }}
      >
        Save pool
      </button>
      </div>
      <p class="muted small">{host.dhcpServer.leases.size} active leases</p>
      {err && <div class="err">{err}</div>}
    </div>
  );
}

// ---------------- Switch ----------------

function SwitchConfig({ sw }: { sw: Switch }) {
  const [vid, setVid] = useState('');
  const [vname, setVname] = useState('');
  const [err, setErr] = useState('');
  const changed = () => {
    sw.clearDynamicState();
    touched(sw);
  };
  return (
    <div class="form">
      <h4>VLANs</h4>
      <ul class="list">
        {[...sw.vlans].sort((a, b) => a[0] - b[0]).map(([id, name]) => (
          <li key={id}>
            <span class="data">{id}</span> {name}
            {id !== 1 && (
              <button class="link" onClick={() => (sw.vlans.delete(id), changed())}>
                delete
              </button>
            )}
          </li>
        ))}
      </ul>
      <div class="row gap" data-submit-scope>
        <input class="input narrow" placeholder="10" value={vid} maxLength={4} aria-label="VLAN id" onInput={(e) => setVid((e.target as HTMLInputElement).value)} onKeyDown={submitOnEnter} />
        <input class="input" placeholder="staff" value={vname} maxLength={32} aria-label="VLAN name" onInput={(e) => setVname((e.target as HTMLInputElement).value)} onKeyDown={submitOnEnter} />
        <button
          class="btn small"
          data-submit
          onClick={() => {
            const id = Number(vid);
            if (!/^\d{1,4}$/.test(vid) || id < 2 || id > 4094) return setErr('VLAN id must be 2–4094');
            const n = vname.trim() || `VLAN${String(id).padStart(4, '0')}`;
            if (!/^[A-Za-z0-9._-]{1,32}$/.test(n)) return setErr('Name: letters, digits . _ -');
            sw.vlans.set(id, n);
            setErr('');
            setVid('');
            setVname('');
            changed();
          }}
        >
          Add VLAN
        </button>
      </div>
      {err && <div class="err">{err}</div>}
      <h4>Ports</h4>
      <table class="grid-table">
        <thead>
          <tr>
            <th>Port</th>
            <th>On</th>
            <th>Mode</th>
            <th>VLAN(s)</th>
          </tr>
        </thead>
        <tbody>
          {sw.ports.map((p) => {
            const c = sw.portConfig[p.index]!;
            return (
              <tr key={p.index}>
                <td class="data">{p.name}</td>
                <td>
                  <input type="checkbox" checked={p.enabled} aria-label={`${p.name} enabled`} onChange={(e) => ((p.enabled = (e.target as HTMLInputElement).checked), sw.network.topologyChanged())} />
                </td>
                <td>
                  <select value={c.mode} aria-label={`${p.name} mode`} onChange={(e) => ((c.mode = (e.target as HTMLSelectElement).value as 'access' | 'trunk'), changed())}>
                    <option value="access">access</option>
                    <option value="trunk">trunk</option>
                  </select>
                </td>
                <td>
                  {c.mode === 'access' ? (
                    <select value={String(c.accessVlan)} aria-label={`${p.name} access VLAN`} onChange={(e) => ((c.accessVlan = Number((e.target as HTMLSelectElement).value)), changed())}>
                      {[...sw.vlans.keys()].sort((a, b) => a - b).map((v) => (
                        <option key={v} value={String(v)}>
                          {v}
                        </option>
                      ))}
                      {!sw.vlans.has(c.accessVlan) && <option value={String(c.accessVlan)}>{c.accessVlan} (missing)</option>}
                    </select>
                  ) : (
                    <input
                      class="input narrow data"
                      value={vlanListText(c.allowedVlans)}
                      aria-label={`${p.name} allowed VLANs`}
                      onKeyDown={submitOnEnter}
                      onChange={(e) => {
                        const list = parseVlanList((e.target as HTMLInputElement).value.trim().toLowerCase());
                        if (list !== undefined) {
                          c.allowedVlans = list;
                          changed();
                        }
                      }}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------- Router / Firewall ----------------

function IfaceRow({ router, iface }: { router: Router; iface: L3Interface }) {
  const [val, setVal] = useState(iface.ip === null ? '' : `${formatIp(iface.ip)}/${iface.prefix}`);
  const [bad, setBad] = useState(false);
  const acls = [...router.acls.keys()];
  return (
    <tr>
      <td class="data">{iface.name}</td>
      <td>
        <input
          class={cx('input data', bad && 'invalid')}
          value={val}
          placeholder="10.0.0.1/24"
          aria-label={`${iface.name} address`}
          onInput={(e) => setVal((e.target as HTMLInputElement).value)}
          onKeyDown={submitOnEnter}
          onBlur={() => {
            const t = val.trim();
            if (t === '') {
              iface.ip = null;
              setBad(false);
              return touched(router);
            }
            const c = parseCidr(t.includes('/') ? t : `${t}/24`);
            if (!c) return setBad(true);
            setBad(false);
            iface.ip = c.ip;
            iface.prefix = c.prefix;
            router.clearDynamicState();
            touched(router);
          }}
        />
      </td>
      <td>
        <select value={iface.nat ?? ''} aria-label={`${iface.name} NAT role`} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          if (v === '') delete iface.nat;
          else iface.nat = v as 'inside' | 'outside';
          touched(router);
        }}>
          <option value="">—</option>
          <option value="inside">inside</option>
          <option value="outside">outside</option>
        </select>
      </td>
      <td>
        <select value={iface.aclIn ?? ''} aria-label={`${iface.name} ACL in`} onChange={(e) => {
          const v = (e.target as HTMLSelectElement).value;
          if (v === '') delete iface.aclIn;
          else iface.aclIn = v;
          touched(router);
        }}>
          <option value="">—</option>
          {acls.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </td>
      <td>
        {iface.vlan !== undefined && (
          <button class="link" aria-label={`Delete ${iface.name}`} onClick={() => (router.removeInterface(iface.name), touched(router))}>
            ✕
          </button>
        )}
      </td>
    </tr>
  );
}

function parseAddr(t: string): AddrMatch | null {
  const s = t.trim().toLowerCase();
  if (s === 'any' || s === '') return { any: true };
  const ip = parseIp(s);
  if (ip !== null) return { net: ip, prefix: 32 };
  const c = parseCidr(s);
  return c ? { net: networkOf(c.ip, c.prefix), prefix: c.prefix } : null;
}

function RouterConfig({ router }: { router: Router }) {
  const [sub, setSub] = useState({ port: '0', vlan: '' });
  const [route, setRoute] = useState({ net: '', hop: '' });
  const [fwd, setFwd] = useState({ port: '80', ip: '', inPort: '80' });
  const [acl, setAcl] = useState({ name: 'FILTER', action: 'deny', proto: 'ip', src: 'any', dst: 'any', port: '' });
  const [rule, setRule] = useState({ from: 'outside', to: 'inside', proto: 'tcp', dst: 'any', port: '80' });
  const [err, setErr] = useState('');
  const fail = (m: string) => setErr(m);
  return (
    <div class="form">
      <h4>Interfaces</h4>
      <table class="grid-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Address</th>
            <th>NAT</th>
            <th>ACL in</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {router.interfaces.map((i) => (
            <IfaceRow key={`${router.id}-${i.name}`} router={router} iface={i} />
          ))}
        </tbody>
      </table>
      <div class="row gap" data-submit-scope>
        <select value={sub.port} aria-label="Port for subinterface" onChange={(e) => setSub({ ...sub, port: (e.target as HTMLSelectElement).value })}>
          {router.ports.map((p) => (
            <option key={p.index} value={String(p.index)}>
              {p.name}
            </option>
          ))}
        </select>
        <input class="input narrow" placeholder="VLAN" value={sub.vlan} maxLength={4} aria-label="Subinterface VLAN" onInput={(e) => setSub({ ...sub, vlan: (e.target as HTMLInputElement).value })} onKeyDown={submitOnEnter} />
        <button class="btn small" data-submit onClick={() => {
          const v = Number(sub.vlan);
          if (!/^\d{1,4}$/.test(sub.vlan) || !router.addSubinterface(Number(sub.port), v)) return fail('VLAN must be 1–4094');
          setErr('');
          touched(router);
        }}>
          Add subinterface
        </button>
      </div>

      <h4>Static routes</h4>
      <ul class="list data small">
        {router.staticRoutes.map((r, i) => (
          <li key={i}>
            {formatIp(r.net)}/{r.prefix} via {formatIp(r.nextHop)}
            <button class="link" onClick={() => (router.removeStaticRoute(r), touched(router))}>
              remove
            </button>
          </li>
        ))}
      </ul>
      <div class="row gap" data-submit-scope>
        <input class="input" placeholder="0.0.0.0/0" value={route.net} aria-label="Destination network" onInput={(e) => setRoute({ ...route, net: (e.target as HTMLInputElement).value })} onKeyDown={submitOnEnter} />
        <input class="input" placeholder="next hop" value={route.hop} aria-label="Next hop" onInput={(e) => setRoute({ ...route, hop: (e.target as HTMLInputElement).value })} onKeyDown={submitOnEnter} />
        <button class="btn small" data-submit onClick={() => {
          const c = parseCidr(route.net);
          const h = parseIp(route.hop);
          if (!c || h === null) return fail('Route: network like 10.2.0.0/24 and a next-hop IP');
          router.addStaticRoute({ net: networkOf(c.ip, c.prefix), prefix: c.prefix, nextHop: h });
          setErr('');
          touched(router);
        }}>
          Add
        </button>
      </div>

      <h4>
        <label class="toggle">
          <input type="checkbox" checked={router.nat.enabled} onChange={(e) => ((router.nat.enabled = (e.target as HTMLInputElement).checked), touched(router))} />
          NAT overload (PAT)
        </label>
      </h4>
      <ul class="list data small">
        {router.nat.forwards.map((f, i) => (
          <li key={i}>
            {f.proto} {f.outsidePort} → {formatIp(f.insideIp)}:{f.insidePort}
            <button class="link" onClick={() => ((router.nat.forwards = router.nat.forwards.filter((x) => x !== f)), touched(router))}>
              remove
            </button>
          </li>
        ))}
      </ul>
      <div class="row gap" data-submit-scope>
        <input class="input narrow" value={fwd.port} aria-label="Outside port" onInput={(e) => setFwd({ ...fwd, port: (e.target as HTMLInputElement).value })} onKeyDown={submitOnEnter} />
        <span>→</span>
        <input class="input" placeholder="inside IP" value={fwd.ip} aria-label="Inside IP" onInput={(e) => setFwd({ ...fwd, ip: (e.target as HTMLInputElement).value })} onKeyDown={submitOnEnter} />
        <input class="input narrow" value={fwd.inPort} aria-label="Inside port" onInput={(e) => setFwd({ ...fwd, inPort: (e.target as HTMLInputElement).value })} onKeyDown={submitOnEnter} />
        <button class="btn small" data-submit onClick={() => {
          const ip = parseIp(fwd.ip);
          const a = Number(fwd.port);
          const b = Number(fwd.inPort);
          if (ip === null || !/^\d{1,5}$/.test(fwd.port) || !/^\d{1,5}$/.test(fwd.inPort) || a > 65535 || b > 65535) return fail('Port forward: ports 0–65535 and an inside IP');
          router.nat.forwards = router.nat.forwards.filter((f) => f.outsidePort !== a);
          router.nat.forwards.push({ proto: 'tcp', outsidePort: a, insideIp: ip, insidePort: b });
          setErr('');
          touched(router);
        }}>
          Forward TCP
        </button>
      </div>

      <h4>Access lists</h4>
      {[...router.acls].map(([name, entries]) => (
        <div key={name} class="acl">
          <div class="data">
            {name}
            <button class="link" onClick={() => (router.acls.delete(name), touched(router))}>
              delete list
            </button>
          </div>
          <ol class="data small">
            {entries.map((e: AclEntry, i: number) => (
              <li key={i}>{formatAclEntry(e)}</li>
            ))}
            <li class="muted">(implicit) deny ip any any</li>
          </ol>
        </div>
      ))}
      <div class="row gap wrap" data-submit-scope>
        <input class="input narrow" value={acl.name} aria-label="ACL name" maxLength={32} onInput={(e) => setAcl({ ...acl, name: (e.target as HTMLInputElement).value })} onKeyDown={submitOnEnter} />
        <select value={acl.action} aria-label="Action" onChange={(e) => setAcl({ ...acl, action: (e.target as HTMLSelectElement).value })}>
          <option>permit</option>
          <option>deny</option>
        </select>
        <select value={acl.proto} aria-label="Protocol" onChange={(e) => setAcl({ ...acl, proto: (e.target as HTMLSelectElement).value })}>
          {['ip', 'icmp', 'tcp', 'udp'].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <input class="input" value={acl.src} placeholder="src any|IP|CIDR" aria-label="Source" onInput={(e) => setAcl({ ...acl, src: (e.target as HTMLInputElement).value })} onKeyDown={submitOnEnter} />
        <input class="input" value={acl.dst} placeholder="dst any|IP|CIDR" aria-label="Destination" onInput={(e) => setAcl({ ...acl, dst: (e.target as HTMLInputElement).value })} onKeyDown={submitOnEnter} />
        <input class="input narrow" value={acl.port} placeholder="port" aria-label="Destination port" onInput={(e) => setAcl({ ...acl, port: (e.target as HTMLInputElement).value })} onKeyDown={submitOnEnter} />
        <button class="btn small" data-submit onClick={() => {
          const src = parseAddr(acl.src);
          const dst = parseAddr(acl.dst);
          if (!/^[A-Za-z0-9._-]{1,32}$/.test(acl.name)) return fail('ACL name: letters, digits . _ -');
          if (!src || !dst) return fail('Addresses: any, an IP, or a CIDR like 10.0.20.0/24');
          const entry: AclEntry = { action: acl.action as 'permit' | 'deny', proto: acl.proto as AclEntry['proto'], src, dst };
          if (acl.port.trim()) {
            if (!/^\d{1,5}$/.test(acl.port.trim()) || (acl.proto !== 'tcp' && acl.proto !== 'udp')) return fail('Ports need tcp or udp');
            entry.dstPort = Number(acl.port.trim());
          }
          router.addAclEntry(acl.name, entry);
          setErr('');
          touched(router);
        }}>
          Add rule
        </button>
      </div>
      <p class="muted small">Apply a list with the "ACL in" column above. Rules match top-down; the first match wins.</p>

      {router instanceof Firewall && (
        <>
          <h4>Firewall policy</h4>
          <p class="muted small">Inside → DMZ → Outside is allowed and tracked; replies come back automatically. Anything else needs a rule.</p>
          <ul class="list data small">
            {router.rules.map((r, i) => (
              <li key={i}>
                allow {r.from} → {r.to} {r.proto} {formatAddrMatch(r.dst)}
                {r.dstPort !== undefined ? ` :${r.dstPort}` : ''}
                <button class="link" onClick={() => ((router.rules = router.rules.filter((x) => x !== r)), touched(router))}>
                  remove
                </button>
              </li>
            ))}
            <li class="muted">{router.denied} packets denied so far</li>
          </ul>
          <div class="row gap wrap" data-submit-scope>
            {(['from', 'to'] as const).map((k) => (
              <select key={k} value={rule[k]} aria-label={`Zone ${k}`} onChange={(e) => setRule({ ...rule, [k]: (e.target as HTMLSelectElement).value })}>
                {['inside', 'dmz', 'outside'].map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
            ))}
            <select value={rule.proto} aria-label="Protocol" onChange={(e) => setRule({ ...rule, proto: (e.target as HTMLSelectElement).value })}>
              {['ip', 'icmp', 'tcp', 'udp'].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <input class="input" value={rule.dst} aria-label="Destination" onInput={(e) => setRule({ ...rule, dst: (e.target as HTMLInputElement).value })} onKeyDown={submitOnEnter} />
            <input class="input narrow" value={rule.port} aria-label="Port" onInput={(e) => setRule({ ...rule, port: (e.target as HTMLInputElement).value })} onKeyDown={submitOnEnter} />
            <button class="btn small" data-submit onClick={() => {
              const dst = parseAddr(rule.dst);
              if (!dst) return fail('Destination: any, an IP or a CIDR');
              const port = rule.port.trim();
              if (port && !/^\d{1,5}$/.test(port)) return fail('Port must be a number');
              router.addRule({ from: rule.from as 'inside', to: rule.to as 'inside', proto: rule.proto as 'ip', dst, ...(port ? { dstPort: Number(port) } : {}) });
              setErr('');
              touched(router);
            }}>
              Allow
            </button>
          </div>
        </>
      )}
      {err && <div class="err">{err}</div>}
      <p class="muted small">Prefer typing? Everything here is also in the Terminal tab (try "enable", then "?").</p>
    </div>
  );
}

// ---------------- Cloud ----------------

function CloudConfig({ cloud }: { cloud: Cloud }) {
  const [target, setTarget] = useState('203.0.113.2');
  const wan = cloud.wan;
  return (
    <div class="form">
      <p>
        Your ISP router is <span class="data">{ipText(wan.ip)}/{wan.prefix}</span>. Use another address in that subnet for your edge router and point a default route at the ISP.
      </p>
      <ul class="list small">
        <li>
          Public DNS resolver: <span class="data">{formatIp(INTERNET.dns)}</span>
        </li>
        <li>
          Websites: <span class="data">www.packetflip.test</span>, <span class="data">mirror.packetflip.test</span>
        </li>
        <li class="muted">All addresses are documentation ranges; this "Internet" is fully simulated.</li>
      </ul>
      <h4>Simulate the outside world</h4>
      <div data-submit-scope>
      <div class="row gap">
        <input class="input" value={target} aria-label="Target public IP" maxLength={15} onInput={(e) => setTarget((e.target as HTMLInputElement).value)} onKeyDown={submitOnEnter} />
      </div>
      <div class="row gap">
        <button class="btn small" data-submit onClick={() => {
          const ip = parseIp(target);
          if (ip === null) return store.showToast('Enter a public IPv4 address', 'warn');
          cloud.visit(ip, (r) => store.pushLog(r.ok ? 'ok' : 'bad', `Internet visitor → ${target}: ${r.message}`, cloud.id));
        }}>
          Send a visitor (HTTP)
        </button>
        <button class="btn small danger" onClick={() => {
          const ip = parseIp(target);
          if (ip === null) return store.showToast('Enter a public IPv4 address', 'warn');
          cloud.attack(ip);
          store.pushLog('warn', `Simulated port scan sent to ${target} (ports 22, 23, 445, 3389).`, cloud.id);
        }}>
          Simulate a port scan
        </button>
      </div>
      </div>
    </div>
  );
}

function Field(props: { label: string; value: string; onInput: (v: string) => void; placeholder?: string; onBlur?: () => void }) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <input
        class="input data"
        value={props.value}
        placeholder={props.placeholder}
        maxLength={64}
        onInput={(e) => props.onInput((e.target as HTMLInputElement).value)}
        onBlur={props.onBlur}
        onKeyDown={submitOnEnter}
      />
    </label>
  );
}
