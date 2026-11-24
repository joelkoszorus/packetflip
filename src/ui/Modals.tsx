import { useRef, useState } from 'preact/hooks';
import { SCENARIOS } from '../game/scenarios';
import { loadAutosave, loadStars, autosave } from '../game/progress';
import { encodeShare } from '../persistence/share';
import { saveToText, loadFromText } from '../persistence/serialize';
import { ValidationError } from '../persistence/validate';
import { LIMITS } from '../sim/limits';
import { TRAFFIC_COLORS, TRAFFIC_LABELS } from '../render/meshes';
import type { TrafficClass } from '../sim/net/pdu';
import { cx, fmtTime, submitOnEnter, useStore } from './hooks';

function Stars({ n, of = 3 }: { n: number; of?: number }) {
  return (
    <span class="stars" aria-label={`${n} of ${of} stars`}>
      {Array.from({ length: of }, (_, i) => (
        <span key={i} class={i < n ? 'on' : ''}>
          ★
        </span>
      ))}
    </span>
  );
}

function Modal({ children, wide, onClose }: { children: preact.ComponentChildren; wide?: boolean; onClose?: () => void }) {
  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div class={cx('modal', wide && 'wide')} role="dialog" aria-modal="true">
        {onClose && (
          <button class="close link" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

export function Modals() {
  const s = useStore();
  switch (s.modal) {
    case 'menu':
      return <MainMenu />;
    case 'scenarios':
      return <ScenarioList />;
    case 'briefing':
      return <Briefing />;
    case 'debrief':
      return <Debrief />;
    case 'save':
      return <SaveDialog />;
    case 'help':
      return <Help />;
    case 'share-import':
      return <ShareImport />;
    default:
      return null;
  }
}

function MainMenu() {
  const s = useStore();
  const auto = loadAutosave();
  const canClose = s.net.devices.size > 0;
  return (
    <Modal onClose={canClose ? () => ((s.modal = null), s.changed()) : undefined}>
      <div class="hero">
        <div class="logo" aria-hidden="true">
          ⛕
        </div>
        <h1>Packet Flip</h1>
        <p class="tagline">You are the network engineer. Cable it, configure it, and keep the packets flowing.</p>
      </div>
      <div class="menu-buttons">
        <button class="btn primary big" onClick={() => ((s.modal = 'scenarios'), s.changed())}>
          Play scenarios
          <small>Five tickets from a small business that needs a network engineer</small>
        </button>
        <button class="btn big" onClick={() => s.newSandbox(true)}>
          Sandbox: sample office
          <small>A working network with the Internet attached. Break it and fix it.</small>
        </button>
        <button class="btn big" onClick={() => s.newSandbox(false)}>
          Sandbox: empty floor
        </button>
        {auto && (
          <button class="btn big" onClick={() => s.loadSave(auto)}>
            Continue "{auto.title}"
            <small>
              {auto.devices.length} devices, {auto.links.length} cables
            </small>
          </button>
        )}
        <button class="btn" onClick={() => ((s.modal = 'help'), s.changed())}>
          How to play
        </button>
      </div>
      <p class="muted small center">Runs entirely in your browser. No accounts, no tracking, no real network traffic.</p>
    </Modal>
  );
}

function ScenarioList() {
  const s = useStore();
  const stars = loadStars();
  return (
    <Modal wide onClose={() => ((s.modal = 'menu'), s.changed())}>
      <h2>Scenarios</h2>
      <div class="cards">
        {SCENARIOS.map((sc) => (
          <button key={sc.id} class="card" onClick={() => s.startScenario(sc.id)}>
            <div class="row between">
              <span class="num">#{sc.number}</span>
              <Stars n={stars[sc.id] ?? 0} />
            </div>
            <strong>{sc.title}</strong>
            <span class="muted small">{sc.ticket.subject}</span>
            <div class="concepts">
              {sc.concepts.map((c) => (
                <span key={c} class="chip">
                  {c}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function Briefing() {
  const s = useStore();
  const sc = s.run?.scenario;
  if (!sc) return null;
  const start = () => ((s.modal = null), s.changed());
  return (
    <Modal onClose={start}>
      <div class="email">
        <div class="email-head">
          <div>
            <span class="muted">From:</span> {sc.ticket.from}
          </div>
          <div>
            <span class="muted">Subject:</span> <strong>{sc.ticket.subject}</strong>
          </div>
        </div>
        {sc.ticket.body.map((l, i) => (
          <p key={i}>{l}</p>
        ))}
      </div>
      <div class="meters">
        <div class="meter">
          <span>Budget</span>
          <strong>${sc.budget}</strong>
        </div>
        <div class="meter">
          <span>Par time</span>
          <strong>{fmtTime(sc.parSeconds * 1000)}</strong>
        </div>
        <div class="meter">
          <span>Objectives</span>
          <strong>{sc.objectives.length}</strong>
        </div>
      </div>
      <p class="muted small">
        ★ resolve the ticket · ★ stay within budget and par time · ★ follow best practice. Press "Test my network" when you think it is fixed.
      </p>
      <button class="btn primary wide" onClick={start}>
        Take the ticket
      </button>
    </Modal>
  );
}

function Debrief() {
  const s = useStore();
  const run = s.run;
  if (!run?.result) return null;
  const r = run.result;
  const next = s.nextScenario();
  return (
    <Modal onClose={() => ((s.modal = null), s.changed())}>
      <h2 class="center">Ticket resolved</h2>
      <div class="center big-stars">
        <Stars n={r.stars} />
      </div>
      <ul class="objectives">
        <li class="pass">
          <span class="mark">✔</span>All objectives met
        </li>
        <li class={r.underBudget && r.underPar ? 'pass' : 'fail'}>
          <span class="mark">{r.underBudget && r.underPar ? '✔' : '✖'}</span>
          <div>
            Budget ${s.spent()} / ${run.scenario.budget} · Time {fmtTime(run.elapsed * 1000)} / {fmtTime(run.scenario.parSeconds * 1000)}
          </div>
        </li>
        {run.bestChecks.map((c) => (
          <li key={c.id} class={c.pass ? 'pass' : 'fail'}>
            <span class="mark">{c.pass ? '✔' : '✖'}</span>
            <div>
              {c.label}
              <div class="muted small">{c.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      <div class="row gap center">
        <button class="btn" onClick={() => s.startScenario(run.scenario.id)}>
          Replay
        </button>
        {next ? (
          <button class="btn primary" onClick={() => s.startScenario(next.id)}>
            Next: {next.title}
          </button>
        ) : (
          <button class="btn primary" onClick={() => s.newSandbox(true)}>
            Free play in the sandbox
          </button>
        )}
        <button class="btn" onClick={() => ((s.modal = null), s.changed())}>
          Keep exploring
        </button>
      </div>
    </Modal>
  );
}

function SaveDialog() {
  const s = useStore();
  const [title, setTitle] = useState(s.title);
  const [link, setLink] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const close = () => ((s.modal = null), s.changed());
  const snap = () => {
    const t = title.trim().slice(0, 64) || 'Untitled network';
    s.title = t;
    return s.snapshot();
  };
  return (
    <Modal onClose={close}>
      <h2>Save & share</h2>
      <label class="field">
        <span>Name</span>
        <input class="input" value={title} maxLength={64} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} onKeyDown={submitOnEnter} />
      </label>
      <div class="menu-buttons">
        <button class="btn" onClick={() => {
          autosave(snap());
          setMsg({ ok: true, text: 'Saved in this browser. Use "Continue" on the start screen.' });
        }}>
          Save in this browser
        </button>
        <button class="btn" onClick={() => {
          const blob = new Blob([saveToText(snap())], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${(title.trim() || 'network').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40)}.packetflip.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>
          Export file (.json)
        </button>
        <button class="btn" onClick={() => fileInput.current?.click()}>
          Import file…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          class="hidden"
          onChange={async (e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            (e.target as HTMLInputElement).value = '';
            if (!f) return;
            if (f.size > LIMITS.maxSaveBytes) return setMsg({ ok: false, text: 'That file is too large to be a Packet Flip network.' });
            try {
              s.loadSave(loadFromText(await f.text()));
            } catch (err) {
              setMsg({ ok: false, text: err instanceof ValidationError ? `Could not load: ${err.message}` : 'Could not load that file.' });
            }
          }}
        />
        <button class="btn primary" onClick={async () => {
          try {
            const code = await encodeShare(snap());
            const url = `${location.origin}${location.pathname}#topo=${code}`;
            setLink(url);
            try {
              await navigator.clipboard.writeText(url);
              setMsg({ ok: true, text: 'Link copied. The network is stored in the link itself, nothing is uploaded.' });
            } catch {
              setMsg({ ok: true, text: 'Copy the link below. The network is stored in the link itself.' });
            }
          } catch (err) {
            setMsg({ ok: false, text: err instanceof Error ? err.message : 'Could not create a link' });
          }
        }}>
          Create share link
        </button>
      </div>
      {link && <textarea class="input data share" readOnly value={link} rows={3} onFocus={(e) => (e.target as HTMLTextAreaElement).select()} />}
      {msg && <div class={msg.ok ? 'okmsg' : 'err'}>{msg.text}</div>}
    </Modal>
  );
}

function ShareImport() {
  const s = useStore();
  const save = s.pendingShare;
  if (!save) return null;
  const done = () => {
    s.pendingShare = null;
    history.replaceState(null, '', location.pathname + location.search);
  };
  return (
    <Modal>
      <h2>Open a shared network?</h2>
      <p>
        Someone shared <strong>{save.title}</strong>: {save.devices.length} devices and {save.links.length} cables.
      </p>
      <p class="muted small">It has been checked and contains only network settings. It opens in a new sandbox.</p>
      <div class="row gap">
        <button class="btn primary" onClick={() => (done(), s.loadSave(save))}>
          Open it
        </button>
        <button class="btn" onClick={() => (done(), (s.modal = 'menu'), s.changed())}>
          No thanks
        </button>
      </div>
    </Modal>
  );
}

function Help() {
  const s = useStore();
  return (
    <Modal wide onClose={() => ((s.modal = s.net.devices.size ? null : 'menu'), s.changed())}>
      <h2>How to play</h2>
      <div class="help-grid">
        <div>
          <h4>Build</h4>
          <ul class="small">
            <li>Pick a device in the palette and click the floor to place it.</li>
            <li>
              <kbd>C</kbd> Cable: click a device, choose a port, then click the other device.
            </li>
            <li>
              <kbd>V</kbd> Select: click to inspect, drag to move.
            </li>
            <li>
              Group: drag on empty floor to box-select, <kbd>Shift</kbd>-click to add, <kbd>Ctrl</kbd>+<kbd>A</kbd> for all. Drag any of them to move the group; cables stay connected.
            </li>
            <li>
              <kbd>U</kbd> Unplug a cable · <kbd>X</kbd> delete.
            </li>
          </ul>
          <h4>Configure</h4>
          <ul class="small">
            <li>Use the Inspector forms, or open the Terminal tab and type commands.</li>
            <li>
              Routers & switches: <span class="data">enable</span>, <span class="data">configure terminal</span>, then <span class="data">?</span> lists every command.
            </li>
            <li>
              PCs: <span class="data">ipconfig</span>, <span class="data">ping</span>, <span class="data">tracert</span>, <span class="data">nslookup</span>, <span class="data">browse</span>.
            </li>
          </ul>
        </div>
        <div>
          <h4>Watch</h4>
          <ul class="small">
            <li>
              <kbd>P</kbd> Ping tool: click a source, then a destination.
            </li>
            <li>Packet trace + Step mode follows packets one hop at a time and opens each layer.</li>
            <li>Red labels over a device tell you why it dropped a packet.</li>
          </ul>
          <h4>Camera</h4>
          <ul class="small">
            <li>Right-drag to pan, scroll to zoom.</li>
            <li>
              <kbd>R</kbd> reset view · <kbd>T</kbd> top-down · <kbd>Space</kbd> pause · <kbd>Esc</kbd> cancel / menu
            </li>
          </ul>
          <h4>Packet colors</h4>
          <div class="legend">
            {(Object.keys(TRAFFIC_LABELS) as TrafficClass[]).map((c) => (
              <span key={c} class="chip">
                <span class="swatch" style={{ background: `#${TRAFFIC_COLORS[c].toString(16).padStart(6, '0')}` }} />
                {TRAFFIC_LABELS[c]}
              </span>
            ))}
          </div>
        </div>
      </div>
      <p class="muted small license-line">
        Packet Flip is open source under the{' '}
        <a href="./LICENSE.txt" target="_blank" rel="noopener noreferrer">
          MIT License
        </a>
        . It includes three.js, Preact and the Atkinson Hyperlegible font:{' '}
        <a href="./licenses/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener noreferrer">
          third-party licenses
        </a>
        .
      </p>
    </Modal>
  );
}
