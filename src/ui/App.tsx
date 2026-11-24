import { useEffect } from 'preact/hooks';
import type { BoardRenderer } from '../render/board';
import { store } from '../game/store';
import { cx, fmtTime, useStore, useTicker } from './hooks';
import { LeftPanel } from './LeftPanel';
import { Inspector } from './Inspector';
import { BottomPanel } from './BottomPanel';
import { Modals } from './Modals';

export function App({ board }: { board: BoardRenderer }) {
  const s = useStore();
  useEffect(() => bindKeys(board), [board]);
  return (
    <div class={cx('hud', s.modal && 'behind-modal')}>
      <TopBar board={board} />
      <LeftPanel />
      <Inspector />
      <BottomPanel />
      <PortPicker />
      {s.toast && (
        <div class={cx('toast', s.toast.level)} role="status">
          {s.toast.text}
        </div>
      )}
      <Modals />
    </div>
  );
}

function TopBar({ board }: { board: BoardRenderer }) {
  const s = useStore();
  useTicker(500);
  const speeds: [0 | 1 | 3, string, string][] = [
    [0, '⏸', 'Pause'],
    [1, '▶', 'Normal speed'],
    [3, '⏩', '3× speed'],
  ];
  return (
    <header class="topbar panel">
      <div class="brand">
        <span class="logo-sm" aria-hidden="true">
          ⛕
        </span>
        <strong>Packet Flip</strong>
        <span class="mode">{s.title}</span>
      </div>
      <div class="time">
        {speeds.map(([v, icon, label]) => (
          <button key={v} class={cx('icon-btn', s.speed === v && !s.traceMode && 'on')} title={label} aria-label={label} onClick={() => (s.traceMode ? s.setTraceMode(false) : null, s.setSpeed(v))}>
            {icon}
          </button>
        ))}
        <span class="clock data" title="Simulated time">
          {fmtTime(s.net.engine.now)}
        </span>
        {s.traceMode && <span class="chip warn">STEP MODE</span>}
      </div>
      <div class="actions">
        <button class="btn small" onClick={() => board.resetCamera()} title="Reset view (R)">
          View
        </button>
        <button class="btn small" onClick={() => ((s.modal = 'save'), s.changed())}>
          Save / Share
        </button>
        <button class="btn small" onClick={() => ((s.modal = 'help'), s.changed())}>
          Help
        </button>
        <button class="btn small" onClick={() => ((s.modal = 'menu'), s.changed())}>
          Menu
        </button>
      </div>
    </header>
  );
}

function PortPicker() {
  const s = useStore();
  const pick = s.portPick;
  if (!pick) return null;
  const d = s.net.device(pick.device);
  if (!d) return null;
  const x = Math.min(pick.x + 12, window.innerWidth - 220);
  const y = Math.min(pick.y + 12, window.innerHeight - 40 - d.ports.length * 30);
  return (
    <div class="port-picker panel" style={{ left: `${x}px`, top: `${y}px` }} role="menu">
      <div class="small muted">{d.name}: choose a port</div>
      {d.ports.map((p) => {
        const peer = p.link?.peer(d.id, p.index);
        return (
          <button key={p.index} role="menuitem" class="port-item" disabled={!!p.link} onClick={() => s.pickPort(d.id, p.index)}>
            <span class="data">{p.name}</span>
            <span class="muted small">{peer ? `→ ${s.net.device(peer.device)?.name}` : 'free'}</span>
          </button>
        );
      })}
      <button class="link small" onClick={() => s.cancelPortPick()}>
        cancel
      </button>
    </div>
  );
}

function bindKeys(board: BoardRenderer): () => void {
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const s = store;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !s.modal) {
      e.preventDefault();
      s.setTool({ kind: 'select' });
      s.selectAll();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (s.modal && e.key !== 'Escape') return;
    switch (e.key.toLowerCase()) {
      case 'v':
        s.setTool({ kind: 'select' });
        break;
      case 'c':
        s.setTool({ kind: 'cable', cable: s.tool.kind === 'cable' ? s.tool.cable : 'copper' });
        break;
      case 'p':
        s.setTool({ kind: 'ping' });
        break;
      case 'u':
        s.setTool({ kind: 'unlink' });
        break;
      case 'x':
        s.setTool({ kind: 'delete' });
        break;
      case 'delete':
      case 'backspace':
        if (s.group.size > 1) {
          if (window.confirm(`Delete ${s.group.size} selected devices and their cables?`)) s.deleteGroup();
        } else if (s.selected) s.deleteDevice(s.selected);
        break;
      case ' ':
        e.preventDefault();
        if (s.traceMode) s.stepTrace();
        else s.setSpeed(s.speed === 0 ? 1 : 0);
        break;
      case 'r':
        board.resetCamera();
        break;
      case 't':
        board.toggleTopDown();
        break;
      case 'arrowleft':
      case 'a':
        board.panBy(-1.5, 1.5);
        break;
      case 'arrowright':
      case 'd':
        board.panBy(1.5, -1.5);
        break;
      case 'arrowup':
      case 'w':
        board.panBy(-1.5, -1.5);
        break;
      case 'arrowdown':
      case 's':
        board.panBy(1.5, 1.5);
        break;
      case 'escape':
        if (s.modal) {
          if (s.modal !== 'share-import' && s.net.devices.size > 0) s.modal = null;
          s.changed();
        } else if (s.portPick) s.cancelPortPick();
        else if (s.tool.kind !== 'select') s.setTool({ kind: 'select' });
        else if (s.selected) s.select(null);
        else {
          s.modal = 'menu';
          s.changed();
        }
        break;
      default:
        return;
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
