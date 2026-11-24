import { useState } from 'preact/hooks';
import { CATALOG, CABLES, FLOW_LABEL, Host, Cloud, type DeviceKind, type FlowKind } from '../sim';
import { store, type Tool } from '../game/store';
import { parseWebTarget } from '../sim/services/apps';
import { cx, fmtTime, submitOnEnter, useStore, useTicker } from './hooks';

const DEVICE_ICON: Record<DeviceKind, string> = {
  pc: '🖥',
  laptop: '💻',
  server: '🗄',
  printer: '🖨',
  phone: '☎',
  switch: '⇄',
  router: '⛕',
  firewall: '🧱',
  cloud: '☁',
};

const TOOLS: { tool: Tool; key: string; label: string; title: string }[] = [
  { tool: { kind: 'select' }, key: 'V', label: 'Select', title: 'Select and drag devices' },
  { tool: { kind: 'cable', cable: 'copper' }, key: 'C', label: 'Cable', title: 'Connect two ports with a cable' },
  { tool: { kind: 'ping' }, key: 'P', label: 'Ping', title: 'Click a source, then a destination' },
  { tool: { kind: 'unlink' }, key: 'U', label: 'Unplug', title: 'Click a cable to remove it' },
  { tool: { kind: 'delete' }, key: 'X', label: 'Delete', title: 'Click a device or cable to remove it' },
];

export function LeftPanel() {
  const s = useStore();
  return (
    <aside class="left-col">
      <section class="panel">
        <h3>Tools</h3>
        <div class="tool-grid">
          {TOOLS.map((t) => (
            <button
              key={t.key}
              class={cx('tool', s.tool.kind === t.tool.kind && 'on')}
              title={`${t.title} (${t.key})`}
              aria-pressed={s.tool.kind === t.tool.kind}
              onClick={() => s.setTool(t.tool.kind === 'cable' && s.tool.kind === 'cable' ? s.tool : t.tool)}
            >
              <span>{t.label}</span>
              <kbd>{t.key}</kbd>
            </button>
          ))}
        </div>
        {s.tool.kind === 'cable' && (
          <div class="seg small">
            {(['copper', 'fiber'] as const).map((c) => (
              <button key={c} class={cx(s.tool.kind === 'cable' && s.tool.cable === c && 'on')} onClick={() => s.setTool({ kind: 'cable', cable: c })}>
                {c === 'copper' ? 'Copper' : 'Fiber'} ${CABLES[c].cost}
              </button>
            ))}
          </div>
        )}
        <ToolHint />
      </section>
      <section class="panel">
        <h3>{s.mode === 'scenario' ? 'Parts you can buy' : 'Devices'}</h3>
        {s.paletteKinds().length === 0 ? (
          <p class="muted small">This ticket is fix-only: no purchases needed.</p>
        ) : (
          <div class="palette">
            {s.paletteKinds().map((k) => (
              <button
                key={k}
                class={cx('part', s.tool.kind === 'place' && s.tool.device === k && 'on')}
                title={CATALOG[k].blurb}
                onClick={() => s.setTool({ kind: 'place', device: k })}
              >
                <span class="part-icon" aria-hidden="true">
                  {DEVICE_ICON[k]}
                </span>
                <span class="part-name">{CATALOG[k].label}</span>
                {s.mode === 'scenario' && <span class="part-cost">${CATALOG[k].cost}</span>}
              </button>
            ))}
          </div>
        )}
      </section>
      {s.mode === 'scenario' ? <ScenarioPanel /> : <SandboxPanel />}
    </aside>
  );
}

function ToolHint() {
  const s = useStore();
  const t = s.tool;
  let text: string;
  if (t.kind === 'cable') text = t.from ? 'Now click the device at the other end.' : 'Click the first device to plug in.';
  else if (t.kind === 'ping') text = t.from ? `From ${s.net.device(t.from)?.name}: click the destination.` : 'Click the device to ping from.';
  else if (t.kind === 'place') text = `Click the floor to place a ${CATALOG[t.device].label}. Esc to stop.`;
  else if (t.kind === 'unlink') text = 'Click a cable to unplug it.';
  else if (t.kind === 'delete') text = 'Click a device or cable to remove it.';
  else if (s.group.size > 1) text = `${s.group.size} selected: drag one to move them all. Cables stay connected.`;
  else text = 'Tip: drag on empty floor to select several devices; Shift-click to add.';
  return <p class="hint">{text}</p>;
}

function ScenarioPanel() {
  const s = useStore();
  useTicker(1000);
  const run = s.run!;
  const sc = run.scenario;
  const spent = s.spent();
  const over = spent > sc.budget;
  const checks = new Map(run.checks.map((c) => [c.id, c]));
  return (
    <section class="panel scenario">
      <h3>Ticket</h3>
      <div class="ticket-mini">
        <strong>{sc.ticket.subject}</strong>
        <div class="muted small">from {sc.ticket.from}</div>
        {sc.ticket.body.map((l, i) => (
          <p key={i} class="small">
            {l}
          </p>
        ))}
      </div>
      <div class="meters">
        <div class={cx('meter', over && 'bad')}>
          <span>Spent</span>
          <strong>
            ${spent} / ${sc.budget}
          </strong>
        </div>
        <div class={cx('meter', run.elapsed > sc.parSeconds && 'bad')}>
          <span>Time</span>
          <strong>
            {fmtTime(run.elapsed * 1000)} / {fmtTime(sc.parSeconds * 1000)}
          </strong>
        </div>
      </div>
      <h4>Objectives</h4>
      <ul class="objectives">
        {sc.objectives.map((o) => {
          const c = checks.get(o.id);
          return (
            <li key={o.id} class={c ? (c.pass ? 'pass' : 'fail') : 'todo'}>
              <span class="mark" aria-hidden="true">
                {c ? (c.pass ? '✔' : '✖') : '○'}
              </span>
              <div>
                {o.label}
                {c && <div class="muted small">{c.detail}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      <button class="btn primary wide" onClick={() => s.checkObjectives()}>
        Test my network
      </button>
      <h4>Hints</h4>
      <ol class="hints small">
        {sc.hints.slice(0, run.hints).map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ol>
      {run.hints < sc.hints.length && (
        <button class="btn small" onClick={() => s.revealHint()}>
          Show a hint ({run.hints}/{sc.hints.length})
        </button>
      )}
      <div class="concepts">
        {sc.concepts.map((c) => (
          <span key={c} class="chip">
            {c}
          </span>
        ))}
      </div>
    </section>
  );
}

const FLOW_KINDS: FlowKind[] = ['web', 'ping', 'voip', 'visit', 'attack'];

function SandboxPanel() {
  const s = useStore();
  useTicker(1000);
  const [kind, setKind] = useState<FlowKind>('web');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [err, setErr] = useState('');
  const isp = [...s.net.devices.values()].find((d) => d instanceof Cloud);
  const hosts = [...s.net.devices.values()].filter((d) => d instanceof Host);
  const needsIsp = kind === 'attack' || kind === 'visit';
  const sources = needsIsp ? (isp ? [isp] : []) : hosts;
  return (
    <section class="panel">
      <h3>Traffic</h3>
      <p class="muted small">Users generate traffic on a schedule. Watch the packets, then break something.</p>
      <ul class="flows">
        {[...s.traffic.flows.values()].map((f) => {
          const st = s.traffic.stats.get(f.id)!;
          return (
            <li key={f.id} class={st.lastOk === null ? '' : st.lastOk ? 'pass' : 'fail'}>
              <div class="row between">
                <label class="toggle">
                  <input type="checkbox" checked={f.enabled} onChange={(e) => ((f.enabled = (e.target as HTMLInputElement).checked), s.changed())} />
                  {FLOW_LABEL[f.kind]}
                </label>
                <button class="link" aria-label="Remove flow" onClick={() => (s.traffic.remove(f.id), s.changed())}>
                  ✕
                </button>
              </div>
              <div class="small data">
                {s.net.device(f.from)?.name ?? '?'} → {f.to}
              </div>
              <div class="small muted">
                ✔ {st.ok} · ✖ {st.fail} · {st.last}
              </div>
            </li>
          );
        })}
      </ul>
      <div class="flow-form" data-submit-scope>
        <select value={kind} aria-label="Traffic type" onChange={(e) => setKind((e.target as HTMLSelectElement).value as FlowKind)}>
          {FLOW_KINDS.map((k) => (
            <option key={k} value={k}>
              {FLOW_LABEL[k]}
            </option>
          ))}
        </select>
        <select value={from} aria-label="Source device" onChange={(e) => setFrom((e.target as HTMLSelectElement).value)}>
          <option value="">from…</option>
          {sources.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <input
          class="input"
          value={to}
          maxLength={63}
          placeholder={needsIsp ? 'public IP' : 'IP or hostname'}
          aria-label="Destination"
          onInput={(e) => setTo((e.target as HTMLInputElement).value)}
          onKeyDown={submitOnEnter}
        />
        <button
          class="btn small"
          data-submit
          onClick={() => {
            let t = to.trim();
            if (!from || !s.net.device(from)) return setErr('Pick a source device');
            if (kind === 'web') {
              const web = parseWebTarget(t);
              if (typeof web === 'string') return setErr(web);
              t = web.host;
            }
            if (!/^[A-Za-z0-9.-]{1,63}$/.test(t)) return setErr('Destination: an IP address or hostname');
            if (s.traffic.flows.size >= 64) return setErr('Too many flows');
            s.traffic.add({ kind, from, to: t, everyMs: kind === 'attack' ? 15_000 : 6000, enabled: true });
            setErr('');
            setTo('');
            s.changed();
          }}
        >
          Add
        </button>
      </div>
      {needsIsp && !isp && <p class="err small">Place the ISP / Internet first.</p>}
      {err && <p class="err small">{err}</p>}
    </section>
  );
}

export { store };
