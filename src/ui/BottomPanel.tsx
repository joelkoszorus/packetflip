import { useState } from 'preact/hooks';
import { DROP_REASON_TEXT, formatIp, trafficClass, type Frame, type IpPacket, type ArpPacket } from '../sim';
import type { TrafficClass } from '../sim/net/pdu';
import { TRAFFIC_COLORS, TRAFFIC_LABELS } from '../render/meshes';
import type { TraceEntry } from '../game/store';
import { cx, useStore } from './hooks';
import { ResizeHandle } from './Resize';

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const CLASSES = Object.keys(TRAFFIC_LABELS) as TrafficClass[];

function summary(frame: Frame): string {
  if (frame.etherType === 'arp') {
    const a = frame.payload as ArpPacket;
    return a.op === 'request' ? `ARP who has ${formatIp(a.targetIp)}? tell ${formatIp(a.senderIp)}` : `ARP ${formatIp(a.senderIp)} is at ${a.senderMac}`;
  }
  const p = frame.payload as IpPacket;
  const l4 = p.l4;
  const ends = `${formatIp(p.src)} → ${formatIp(p.dst)}`;
  if (l4.proto === 'icmp') return `ICMP ${l4.type}${l4.reason ? ` (${l4.reason})` : ''} ${ends}`;
  const app = l4.payload;
  const flag = l4.proto === 'tcp' ? ` [${l4.flag}]` : '';
  if (!app) return `TCP${flag} ${ends}:${l4.dstPort}`;
  switch (app.app) {
    case 'dns':
      return app.kind === 'query' ? `DNS query ${app.name}` : `DNS answer ${app.name} = ${app.ip === null ? 'NXDOMAIN' : formatIp(app.ip)}`;
    case 'dhcp':
      return `DHCP ${app.kind.toUpperCase()}${app.yourIp !== undefined ? ` ${formatIp(app.yourIp)}` : ''}`;
    case 'http':
      return app.kind === 'request' ? `HTTP GET ${app.host}${app.path}${flag}` : `HTTP ${app.status}${flag}`;
    case 'data':
      return `${app.label} ${ends}`;
  }
}

export function BottomPanel() {
  const s = useStore();
  const [tab, setTab] = useState<'log' | 'trace'>('log');
  const [open, setOpen] = useState(true);
  return (
    <section class={cx('panel bottom', !open && 'collapsed')}>
      {open && <ResizeHandle size="--bottom-h" label="log panel" />}
      <div class="bottom-bar">
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'log'} class={cx('tab', tab === 'log' && 'on')} onClick={() => (setTab('log'), setOpen(true))}>
            Event log
          </button>
          <button role="tab" aria-selected={tab === 'trace'} class={cx('tab', tab === 'trace' && 'on')} onClick={() => (setTab('trace'), setOpen(true))}>
            Packet trace
          </button>
        </div>
        {tab === 'trace' && open && (
          <div class="row gap">
            <label class="toggle">
              <input type="checkbox" checked={s.traceMode} onChange={(e) => s.setTraceMode((e.target as HTMLInputElement).checked)} />
              Step mode
            </label>
            <button class="btn small primary" disabled={!s.traceMode} onClick={() => s.stepTrace()} title="Advance until the next packet arrives">
              Step ▶
            </button>
            <button class="btn small" onClick={() => ((s.traceEntries = []), (s.inspectTrace = null), s.changed())}>
              Clear
            </button>
          </div>
        )}
        <button class="link" aria-label={open ? 'Collapse panel' : 'Expand panel'} onClick={() => setOpen(!open)}>
          {open ? '▾' : '▴'}
        </button>
      </div>
      {open && (tab === 'log' ? <LogView /> : <TraceView />)}
    </section>
  );
}

function LogView() {
  const s = useStore();
  const items = s.log.slice(-60).reverse();
  return (
    <ul class="log">
      {items.length === 0 && <li class="muted">Nothing yet. Things that happen on the network show up here.</li>}
      {items.map((l) => (
        <li key={l.id} class={l.level}>
          <span class="t data">{(l.time / 1000).toFixed(1)}s</span>
          <button class="link plain" onClick={() => l.device && s.select(l.device)}>
            {l.text}
          </button>
        </li>
      ))}
    </ul>
  );
}

function TraceView() {
  const s = useStore();
  const filter = s.traceFilter;
  const name = (id: string) => s.net.device(id)?.name ?? '?';
  const visible = s.traceEntries
    .filter((t) => t.type === 'drop' || filter.size === 0 || filter.has(trafficClass(t.frame)))
    .slice(-150)
    .reverse();
  const selected = s.traceEntries.find((t) => t.id === s.inspectTrace) ?? null;
  return (
    <div class="trace">
      <div class="trace-left">
        <div class="legend">
          {CLASSES.map((c) => (
            <button
              key={c}
              class={cx('chip', filter.size > 0 && !filter.has(c) && 'dim')}
              onClick={() => {
                if (filter.has(c)) filter.delete(c);
                else filter.add(c);
                s.changed();
              }}
            >
              <span class="swatch" style={{ background: hex(TRAFFIC_COLORS[c]) }} />
              {TRAFFIC_LABELS[c]}
            </button>
          ))}
        </div>
        <ul class="trace-list">
          {visible.length === 0 && <li class="muted">Turn on Step mode, send a ping, then press Step to follow each hop.</li>}
          {visible.map((t) => (
            <li key={t.id} class={cx(t.type === 'drop' && 'bad', s.inspectTrace === t.id && 'on')}>
              <button class="link plain" onClick={() => ((s.inspectTrace = t.id), s.changed())}>
                <span class="t data">{(t.time / 1000).toFixed(2)}s</span>
                {t.type === 'hop' ? (
                  <>
                    <span class="swatch" style={{ background: hex(TRAFFIC_COLORS[trafficClass(t.frame)]) }} />
                    {name(t.from.device)} → {name(t.to.device)}: {summary(t.frame)}
                  </>
                ) : (
                  <>
                    ✖ {name(t.device)} dropped: {DROP_REASON_TEXT[t.reason]}
                    {t.detail ? ` (${t.detail})` : ''}
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <PduInspector entry={selected} />
    </div>
  );
}

function PduInspector({ entry }: { entry: TraceEntry | null }) {
  const s = useStore();
  if (!entry) return <div class="pdu muted">Select a trace line to open the packet layer by layer.</div>;
  const frame = entry.frame;
  const layers: { title: string; rows: [string, string][] }[] = [];
  if (entry.type === 'drop') {
    layers.push({
      title: 'Why it was dropped',
      rows: [
        ['Device', s.net.device(entry.device)?.name ?? '?'],
        ['Reason', DROP_REASON_TEXT[entry.reason]],
        ...(entry.detail ? ([['Detail', entry.detail]] as [string, string][]) : []),
      ],
    });
  } else {
    const fp = s.net.device(entry.from.device);
    const tp = s.net.device(entry.to.device);
    layers.push({
      title: 'Layer 1 · Physical',
      rows: [
        ['From', `${fp?.name} ${fp?.ports[entry.from.port]?.name ?? ''}`],
        ['To', `${tp?.name} ${tp?.ports[entry.to.port]?.name ?? ''}`],
        ['On the wire', `${((entry.end - entry.time) / 1000).toFixed(2)}s`],
      ],
    });
  }
  if (frame) {
    layers.push({
      title: 'Layer 2 · Ethernet',
      rows: [
        ['Source MAC', frame.src],
        ['Destination MAC', frame.dst === 'ff:ff:ff:ff:ff:ff' ? 'ff:ff:ff:ff:ff:ff (broadcast)' : frame.dst],
        ['802.1Q VLAN tag', frame.vlan === undefined ? 'none (untagged)' : String(frame.vlan)],
        ['Type', frame.etherType.toUpperCase()],
      ],
    });
    if (frame.etherType === 'arp') {
      const a = frame.payload as ArpPacket;
      layers.push({
        title: 'ARP',
        rows: [
          ['Operation', a.op],
          ['Sender', `${formatIp(a.senderIp)} / ${a.senderMac}`],
          ['Target', `${formatIp(a.targetIp)} / ${a.targetMac}`],
        ],
      });
    } else {
      const p = frame.payload as IpPacket;
      layers.push({
        title: 'Layer 3 · IPv4',
        rows: [
          ['Source', formatIp(p.src)],
          ['Destination', formatIp(p.dst)],
          ['TTL', String(p.ttl)],
          ['Packet id', String(p.id)],
          ...(p.hostile ? ([['Simulation tag', 'hostile (simulated attack)']] as [string, string][]) : []),
        ],
      });
      const l4 = p.l4;
      if (l4.proto === 'icmp') {
        layers.push({ title: 'ICMP', rows: [['Type', l4.type], ['Id / seq', `${l4.id} / ${l4.seq}`], ...(l4.reason ? ([['Reason', l4.reason]] as [string, string][]) : [])] });
      } else {
        layers.push({
          title: `Layer 4 · ${l4.proto.toUpperCase()}`,
          rows: [
            ['Source port', String(l4.srcPort)],
            ['Destination port', String(l4.dstPort)],
            ...(l4.proto === 'tcp' ? ([['Flag', l4.flag]] as [string, string][]) : []),
          ],
        });
        const app = l4.payload;
        if (app) {
          const rows: [string, string][] = Object.entries(app)
            .filter(([k]) => k !== 'app')
            .map(([k, v]) => [k, typeof v === 'number' && /ip|gateway|dns|server|relay/i.test(k) ? formatIp(v) : String(v)]);
          layers.push({ title: `Layer 7 · ${app.app.toUpperCase()}`, rows });
        }
      }
    }
  }
  return (
    <div class="pdu">
      {layers.map((l) => (
        <details key={l.title} open>
          <summary>{l.title}</summary>
          <dl>
            {l.rows.map(([k, v]) => (
              <div key={k} class="kv">
                <dt>{k}</dt>
                <dd class="data">{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      ))}
    </div>
  );
}
