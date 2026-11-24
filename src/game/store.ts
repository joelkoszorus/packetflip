/**
 * Game state shared by the renderer and the HUD. Plain observable object:
 * mutate via methods, subscribers are notified on the next animation frame.
 */
import {
  Network,
  TrafficManager,
  CATALOG,
  DROP_REASON_TEXT,
  TopologyError,
  Host,
  L3Node,
  ping,
  formatIp,
  formatProbe,
  type CableType,
  type DeviceKind,
  type Endpoint,
  type Frame,
  type SimEvent,
  type DropReason,
} from '../sim';
import { LIMITS } from '../sim/limits';
import { buildNetwork, serializeNetwork } from '../persistence/serialize';
import type { SaveFile } from '../persistence/validate';
import { SCENARIOS, scenarioById, scoreStars, spentOn, type Scenario, type StarResult } from './scenarios';
import { runChecks, type CheckResult } from './objectives';
import { recordStars } from './progress';
import { defaultSandbox } from './sandbox';

export type Tool =
  | { kind: 'select' }
  | { kind: 'cable'; cable: CableType; from?: Endpoint }
  | { kind: 'delete' }
  | { kind: 'unlink' }
  | { kind: 'place'; device: DeviceKind }
  | { kind: 'ping'; from?: string };

export interface LogEntry {
  id: number;
  time: number;
  level: 'info' | 'ok' | 'warn' | 'bad';
  device?: string;
  text: string;
}

export type TraceEntry =
  | { id: number; type: 'hop'; time: number; end: number; frame: Frame; from: Endpoint; to: Endpoint }
  | { id: number; type: 'drop'; time: number; device: string; reason: DropReason; detail?: string; frame?: Frame };

export interface ScenarioRun {
  scenario: Scenario;
  startDevices: Set<string>;
  startLinks: Set<string>;
  elapsed: number;
  checks: CheckResult[];
  bestChecks: CheckResult[];
  completed: boolean;
  result: StarResult | null;
  hints: number;
}

export type Modal = 'menu' | 'scenarios' | 'briefing' | 'debrief' | 'save' | 'help' | 'share-import' | null;

let nextId = 1;

/** Devices stay within ±BOARD world units of the centre. */
export const BOARD = 40;

export class GameStore {
  net!: Network;
  traffic!: TrafficManager;
  title = 'Sandbox';
  mode: 'sandbox' | 'scenario' = 'sandbox';
  run: ScenarioRun | null = null;
  tool: Tool = { kind: 'select' };
  selected: string | null = null;
  /** Multi-selection (always contains `selected` when one is set). */
  group = new Set<string>();
  speed: 0 | 1 | 3 = 1;
  traceMode = false;
  /** In trace mode, the sim clock target we are animating towards. */
  stepTarget: number | null = null;
  traceEntries: TraceEntry[] = [];
  traceFilter: Set<string> = new Set();
  inspectTrace: number | null = null;
  log: LogEntry[] = [];
  modal: Modal = 'menu';
  pendingShare: SaveFile | null = null;
  toast: { text: string; level: LogEntry['level'] } | null = null;
  /** Increments on every change; components compare it to re-render. */
  version = 0;
  /** Increments when the Network object is replaced. */
  netVersion = 0;

  private listeners = new Set<() => void>();
  private offBus: (() => void) | null = null;
  private notifyQueued = false;
  private lastDrop = new Map<string, number>();
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.replaceNetwork(new Network());
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(): void {
    this.version++;
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const l of this.listeners) l();
    });
  }

  // ---------------- network lifecycle ----------------

  replaceNetwork(net: Network): void {
    this.offBus?.();
    this.net = net;
    this.traffic = new TrafficManager(net);
    this.traffic.onResult = () => this.changed();
    this.offBus = net.bus.on((e) => this.onSimEvent(e));
    this.selected = null;
    this.group = new Set();
    this.traceEntries = [];
    this.inspectTrace = null;
    this.log = [];
    this.lastDrop.clear();
    this.netVersion++;
    this.changed();
  }

  newSandbox(withSample = true): void {
    this.mode = 'sandbox';
    this.run = null;
    this.title = 'Sandbox';
    const net = new Network();
    this.replaceNetwork(net);
    if (withSample) defaultSandbox(net, this.traffic);
    this.modal = null;
    this.tool = { kind: 'select' };
    this.info('Sandbox ready. Build anything: there is no budget and no fail state.');
  }

  startScenario(id: string): void {
    const scenario = scenarioById(id);
    if (!scenario) return;
    const net = new Network();
    scenario.setup(net);
    this.replaceNetwork(net);
    this.mode = 'scenario';
    this.title = `${scenario.number}. ${scenario.title}`;
    this.run = {
      scenario,
      startDevices: new Set(net.devices.keys()),
      startLinks: new Set(net.links.keys()),
      elapsed: 0,
      checks: [],
      bestChecks: [],
      completed: false,
      result: null,
      hints: 0,
    };
    this.tool = { kind: 'select' };
    this.modal = 'briefing';
    this.speed = 1;
    this.changed();
  }

  loadSave(save: SaveFile): void {
    const net = buildNetwork(save);
    this.mode = 'sandbox';
    this.run = null;
    this.title = save.title;
    this.replaceNetwork(net);
    for (const f of save.flows) this.traffic.add(f);
    this.restartDhcp();
    this.modal = null;
    this.info(`Loaded "${save.title}" (${save.devices.length} devices, ${save.links.length} cables).`);
  }

  snapshot(): SaveFile {
    return serializeNetwork(this.net, this.title, this.traffic);
  }

  /** Start DHCP on hosts configured for it (after load or cabling). */
  restartDhcp(): void {
    for (const d of this.net.devices.values()) {
      if (!(d instanceof Host) || !d.dhcpEnabled || !d.portUp(0)) continue;
      const phase = d.dhcpClient.phase;
      if (phase === 'idle' || phase === 'failed') d.useDhcp();
    }
  }

  // ---------------- cable tool: port picker ----------------

  portPick: { device: string; x: number; y: number } | null = null;

  requestPortPick(device: string, x: number, y: number): void {
    const d = this.net.device(device);
    if (!d || this.tool.kind !== 'cable') return;
    if (this.tool.from?.device === device) {
      this.tool = { ...this.tool, from: undefined } as Tool;
      this.changed();
      return;
    }
    const free = d.ports.filter((p) => !p.link);
    if (free.length === 0) {
      this.showToast(`${d.name} has no free ports.`, 'warn');
      return;
    }
    // Single-port devices (and devices with one free port) need no menu.
    if (d.ports.length === 1 || free.length === 1) return this.pickPort(device, free[0]!.index);
    this.portPick = { device, x, y };
    this.changed();
  }

  pickPort(device: string, port: number): void {
    this.portPick = null;
    const tool = this.tool;
    if (tool.kind !== 'cable') return;
    if (!tool.from) {
      this.tool = { kind: 'cable', cable: tool.cable, from: { device, port } };
    } else {
      const ok = this.connect(tool.from, { device, port }, tool.cable);
      this.tool = { kind: 'cable', cable: tool.cable };
      if (ok) {
        const a = this.net.device(tool.from.device);
        const b = this.net.device(device);
        this.info(`Cabled ${a?.name}:${a?.ports[tool.from.port]?.name} ↔ ${b?.name}:${b?.ports[port]?.name}`);
      }
    }
    this.changed();
  }

  cancelPortPick(): void {
    this.portPick = null;
    this.changed();
  }

  // ---------------- ping tool ----------------

  pingClick(device: string): void {
    const tool = this.tool;
    if (tool.kind !== 'ping') return;
    const d = this.net.device(device);
    if (!tool.from) {
      if (!(d instanceof L3Node) || d.kind === 'cloud') return this.showToast('Pick a computer or router to ping from.', 'warn');
      this.tool = { kind: 'ping', from: device };
      this.changed();
      return;
    }
    const src = this.net.device(tool.from) as L3Node | undefined;
    this.tool = { kind: 'ping' };
    if (!src || !(d instanceof L3Node)) return this.changed();
    const dst = d.interfaces.find((i) => i.ip !== null)?.ip;
    if (dst === undefined || dst === null) {
      this.showToast(`${d.name} has no IP address to ping.`, 'warn');
      return this.changed();
    }
    this.runPingFrom(src, dst, d.name);
  }

  runPingFrom(src: L3Node, dst: number, label: string): void {
    const s = ping(src, dst, { count: 3 });
    this.info(`${src.name} → ping ${label} (${formatIp(dst)})…`);
    s.onUpdate = () => {
      if (!s.done) return;
      const ok = s.results.filter((r) => r.kind === 'reply').length;
      const why = s.results.find((r) => r.kind !== 'reply');
      if (ok === s.results.length) this.pushLog('ok', `${src.name} → ${label}: ${ok}/3 replies ✔`);
      else this.pushLog(ok ? 'warn' : 'bad', `${src.name} → ${label}: ${ok}/3 replies. ${why ? formatProbe(why, 'ping') : ''}`);
    };
    this.changed();
  }

  // ---------------- sim events → log/trace ----------------

  private onSimEvent(e: SimEvent): void {
    switch (e.type) {
      case 'hop':
        this.pushTrace({ id: nextId++, type: 'hop', time: e.start, end: e.end, frame: e.frame, from: e.from, to: e.to });
        break;
      case 'drop': {
        this.pushTrace({ id: nextId++, type: 'drop', time: e.time, device: e.device, reason: e.reason, ...(e.detail ? { detail: e.detail } : {}), ...(e.frame ? { frame: e.frame } : {}) });
        // Rate-limit identical drop messages so storms don't flood the log.
        const key = `${e.device}|${e.reason}`;
        const last = this.lastDrop.get(key) ?? -Infinity;
        if (e.time - last > 3000) {
          this.lastDrop.set(key, e.time);
          const name = this.net.device(e.device)?.name ?? '?';
          this.pushLog('warn', `${name}: ${DROP_REASON_TEXT[e.reason]}${e.detail ? ` (${e.detail})` : ''}`, e.device);
        }
        break;
      }
      case 'breach': {
        const name = this.net.device(e.device)?.name ?? '?';
        this.pushLog('bad', `Simulated attack reached ${name}!`, e.device);
        break;
      }
      case 'log':
        this.pushLog('info', `${this.net.device(e.device)?.name ?? '?'}: ${e.text}`, e.device);
        break;
      case 'topology':
      case 'config':
        this.changed();
        break;
      default:
        break;
    }
  }

  private pushTrace(t: TraceEntry): void {
    this.traceEntries.push(t);
    if (this.traceEntries.length > LIMITS.maxTraceEntries) this.traceEntries.splice(0, this.traceEntries.length - LIMITS.maxTraceEntries);
    if (this.traceMode) this.changed();
  }

  pushLog(level: LogEntry['level'], text: string, device?: string): void {
    this.log.push({ id: nextId++, time: this.net.engine.now, level, text: text.slice(0, 200), ...(device ? { device } : {}) });
    if (this.log.length > 200) this.log.shift();
    this.changed();
  }

  info(text: string): void {
    this.pushLog('info', text);
  }

  showToast(text: string, level: LogEntry['level'] = 'info'): void {
    this.toast = { text, level };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = null;
      this.changed();
    }, 3500);
    this.changed();
  }

  // ---------------- editing ----------------

  canPlace(kind: DeviceKind): boolean {
    if (this.mode === 'sandbox') return true;
    return this.run?.scenario.palette.includes(kind) ?? false;
  }

  paletteKinds(): DeviceKind[] {
    if (this.mode === 'scenario') return this.run?.scenario.palette ?? [];
    return ['pc', 'laptop', 'server', 'printer', 'phone', 'switch', 'router', 'firewall', 'cloud'];
  }

  placeDevice(kind: DeviceKind, x: number, z: number): string | null {
    if (!this.canPlace(kind)) return null;
    if (kind === 'cloud' && [...this.net.devices.values()].some((d) => d.kind === 'cloud')) {
      this.showToast('There is only one Internet. The ISP is already on the board.', 'warn');
      return null;
    }
    try {
      const d = this.net.addDevice(kind, { position: { x: Math.round(x), z: Math.round(z) } });
      this.selected = d.id;
      if (this.mode === 'scenario') this.info(`Bought ${CATALOG[kind].label} for $${CATALOG[kind].cost}.`);
      this.changed();
      return d.id;
    } catch (err) {
      this.showToast(err instanceof TopologyError ? err.message : 'Could not place device', 'warn');
      return null;
    }
  }

  moveDevice(id: string, x: number, z: number): void {
    const d = this.net.device(id);
    if (!d) return;
    d.position = { x: Math.max(-BOARD, Math.min(BOARD, x)), z: Math.max(-BOARD, Math.min(BOARD, z)) };
    this.changed();
  }

  /**
   * Move every device in `origins` by the same offset, keeping the group's shape.
   * Only positions change: cables are logical port-to-port links, so every
   * connection (and any traffic on it) is untouched.
   */
  moveGroup(origins: Map<string, { x: number; z: number }>, dx: number, dz: number): void {
    let minDx = -Infinity;
    let maxDx = Infinity;
    let minDz = -Infinity;
    let maxDz = Infinity;
    for (const o of origins.values()) {
      minDx = Math.max(minDx, -BOARD - o.x);
      maxDx = Math.min(maxDx, BOARD - o.x);
      minDz = Math.max(minDz, -BOARD - o.z);
      maxDz = Math.min(maxDz, BOARD - o.z);
    }
    const cx = Math.max(minDx, Math.min(maxDx, dx));
    const cz = Math.max(minDz, Math.min(maxDz, dz));
    for (const [id, o] of origins) {
      const d = this.net.device(id);
      if (d) d.position = { x: o.x + cx, z: o.z + cz };
    }
    this.changed();
  }

  setGroup(ids: Iterable<string>, primary: string | null = null): void {
    this.group = new Set([...ids].filter((id) => this.net.devices.has(id)));
    this.selected = primary !== null && this.group.has(primary) ? primary : ([...this.group][0] ?? null);
    this.changed();
  }

  toggleInGroup(id: string): void {
    const next = new Set(this.group);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.setGroup(next, next.has(id) ? id : this.selected);
  }

  selectAll(): void {
    this.setGroup(this.net.devices.keys(), this.selected);
  }

  /** Delete every selected device the player owns. Returns how many were removed. */
  deleteGroup(): number {
    const ids = [...this.group];
    const owned = ids.filter((id) => !this.run?.startDevices.has(id));
    for (const id of owned) {
      for (const [fid, f] of this.traffic.flows) if (f.from === id) this.traffic.remove(fid);
      this.net.removeDevice(id);
    }
    this.setGroup(ids.filter((id) => !owned.includes(id)));
    if (owned.length < ids.length) this.showToast(`${ids.length - owned.length} customer device(s) were kept: they cannot be removed in this scenario.`, 'warn');
    if (owned.length) this.info(`Deleted ${owned.length} device${owned.length === 1 ? '' : 's'}.`);
    return owned.length;
  }

  deleteDevice(id: string): void {
    const d = this.net.device(id);
    if (!d) return;
    if (this.run?.startDevices.has(id)) {
      this.showToast('That device belongs to the customer. You cannot remove it in this scenario.', 'warn');
      return;
    }
    for (const [fid, f] of this.traffic.flows) if (f.from === id) this.traffic.remove(fid);
    this.net.removeDevice(id);
    this.group.delete(id);
    if (this.selected === id) this.selected = [...this.group][0] ?? null;
    this.changed();
  }

  connect(a: Endpoint, b: Endpoint, cable: CableType): boolean {
    try {
      this.net.connect(a, b, cable);
      this.restartDhcp();
      this.changed();
      return true;
    } catch (err) {
      this.showToast(err instanceof TopologyError ? err.message : 'Could not connect', 'warn');
      return false;
    }
  }

  unlink(linkId: string): void {
    this.net.disconnect(linkId);
    this.changed();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.changed();
  }

  select(id: string | null): void {
    this.selected = id;
    this.group = new Set(id ? [id] : []);
    this.changed();
  }

  setSpeed(speed: 0 | 1 | 3): void {
    this.speed = speed;
    this.stepTarget = null;
    this.changed();
  }

  // ---------------- trace mode ----------------

  setTraceMode(on: boolean): void {
    this.traceMode = on;
    this.speed = on ? 0 : 1;
    this.stepTarget = null;
    this.changed();
  }

  /** Advance to the moment the next frame arrives (animated by the loop). */
  stepTrace(): void {
    const now = this.net.engine.now;
    let next = Infinity;
    for (const t of this.traceEntries) if (t.type === 'hop' && t.end > now + 0.5) next = Math.min(next, t.end);
    if (next === Infinity) {
      // Nothing on the wire: run events until something is transmitted.
      const before = this.traceEntries.length;
      for (let i = 0; i < 2000 && this.traceEntries.length === before && this.net.engine.pending > 0; i++) this.net.engine.step();
      for (const t of this.traceEntries.slice(before)) if (t.type === 'hop') next = Math.min(next, t.end);
    }
    if (next !== Infinity) this.stepTarget = next;
    else this.showToast('Nothing is happening on the network. Send a ping to trace it.', 'info');
    this.changed();
  }

  // ---------------- main loop ----------------

  tick(realDtMs: number): void {
    const dt = Math.min(realDtMs, 100);
    if (this.stepTarget !== null) {
      const remaining = this.stepTarget - this.net.engine.now;
      if (remaining <= 0) this.stepTarget = null;
      else this.net.engine.advance(Math.min(remaining, dt * 0.6));
    } else if (this.speed > 0) {
      this.net.engine.advance(dt * this.speed);
      if (this.net.engine.overloaded) this.showToast('The network is overloaded: is there a loop?', 'bad');
    }
    if (this.run && !this.run.completed && this.modal === null && document.visibilityState === 'visible') {
      this.run.elapsed += dt / 1000;
    }
  }

  // ---------------- scenario checks ----------------

  checkObjectives(): void {
    const run = this.run;
    if (!run) return;
    run.checks = runChecks(this.net, run.scenario.objectives);
    run.bestChecks = runChecks(this.net, run.scenario.bestPractice);
    const done = run.checks.every((c) => c.pass);
    if (done && !run.completed) {
      run.completed = true;
      const best = run.bestChecks.every((c) => c.pass);
      run.result = scoreStars(true, this.spent(), run.scenario.budget, run.elapsed, run.scenario.parSeconds, best);
      recordStars(run.scenario.id, run.result.stars);
      this.modal = 'debrief';
      this.pushLog('ok', `Ticket resolved! ${run.result.stars} star${run.result.stars === 1 ? '' : 's'}.`);
    } else if (!done) {
      const failing = run.checks.filter((c) => !c.pass).length;
      this.pushLog('warn', `${failing} objective${failing === 1 ? '' : 's'} not met yet.`);
    }
    this.changed();
  }

  spent(): number {
    return this.run ? spentOn(this.net, this.run.startDevices, this.run.startLinks) : 0;
  }

  revealHint(): void {
    if (!this.run) return;
    this.run.hints = Math.min(this.run.scenario.hints.length, this.run.hints + 1);
    this.changed();
  }

  nextScenario(): Scenario | undefined {
    if (!this.run) return SCENARIOS[0];
    return SCENARIOS.find((s) => s.number === this.run!.scenario.number + 1);
  }
}

export const store = new GameStore();
