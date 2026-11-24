/**
 * The Network owns every device and cable, the event engine and the event bus.
 * It is the only object that moves frames between devices.
 */
import { Engine } from './engine';
import { EventBus, type DropReason, type Endpoint, type SimEvent } from './events';
import { Link, type CableType } from './link';
import { LIMITS } from './limits';
import { macFromCounter, type Mac } from './net/addr';
import { pduSize, type Frame, type IpPacket } from './net/pdu';
import type { Device, DeviceKind, Position } from './devices/device';
import { Host, type HostKind } from './devices/host';
import { Switch } from './devices/switch';
import { Router } from './devices/router';
import { CATALOG } from './catalog';

export type DeviceFactory = (id: string, kind: DeviceKind, name: string, pos: Position) => Device;

const factories = new Map<DeviceKind, DeviceFactory>();

/** Later layers (firewall, cloud) register themselves here to avoid import cycles. */
export function registerDeviceFactory(kind: DeviceKind, factory: DeviceFactory): void {
  factories.set(kind, factory);
}

registerDeviceFactory('switch', (id, _k, name, pos) => new Switch(id, 'switch', name, pos));
registerDeviceFactory('router', (id, _k, name, pos) => new Router(id, 'router', name, pos));
for (const k of ['pc', 'laptop', 'server', 'printer', 'phone'] as HostKind[]) {
  registerDeviceFactory(k, (id, kind, name, pos) => new Host(id, kind as HostKind, name, pos));
}

export class TopologyError extends Error {}

export class Network {
  readonly engine = new Engine();
  readonly bus = new EventBus();
  readonly devices = new Map<string, Device>();
  readonly links = new Map<string, Link>();

  private macCounter = 1;
  private packetCounter = 1;
  private frameCounter = 1;
  private deviceCounter = 1;
  private linkCounter = 1;
  framesInFlight = 0;

  // ---------- ids ----------
  nextMac(): Mac {
    return macFromCounter(this.macCounter++);
  }
  nextPacketId(): number {
    return this.packetCounter++;
  }

  // ---------- topology ----------
  device<T extends Device = Device>(id: string): T | undefined {
    return this.devices.get(id) as T | undefined;
  }

  deviceByName<T extends Device = Device>(name: string): T | undefined {
    const n = name.toLowerCase();
    for (const d of this.devices.values()) if (d.name.toLowerCase() === n) return d as T;
    return undefined;
  }

  addDevice<T extends Device = Device>(kind: DeviceKind, opts: { name?: string; position?: Position; id?: string } = {}): T {
    if (this.devices.size >= LIMITS.maxDevices) throw new TopologyError(`Device limit reached (${LIMITS.maxDevices})`);
    const factory = factories.get(kind);
    if (!factory) throw new TopologyError(`Unknown device kind: ${kind}`);
    const id = opts.id ?? `d${this.deviceCounter++}`;
    if (this.devices.has(id)) throw new TopologyError(`Duplicate device id ${id}`);
    const match = /^d(\d+)$/.exec(id);
    if (match) this.deviceCounter = Math.max(this.deviceCounter, Number(match[1]) + 1);
    const name = (opts.name ?? this.defaultName(kind)).slice(0, LIMITS.maxNameLength);
    const device = factory(id, kind, name, opts.position ?? { x: 0, z: 0 });
    device.attach(this, CATALOG[kind].ports);
    this.devices.set(id, device);
    this.topologyChanged();
    return device as T;
  }

  private defaultName(kind: DeviceKind): string {
    const base = { pc: 'PC', laptop: 'Laptop', server: 'Server', printer: 'Printer', phone: 'Phone', switch: 'SW', router: 'R', firewall: 'FW', cloud: 'ISP' }[kind];
    for (let i = 1; ; i++) if (!this.deviceByName(`${base}${i}`)) return `${base}${i}`;
  }

  removeDevice(id: string): void {
    const d = this.devices.get(id);
    if (!d) return;
    for (const p of d.ports) if (p.link) this.disconnect(p.link.id);
    this.devices.delete(id);
    this.topologyChanged();
  }

  connect(a: Endpoint, b: Endpoint, cable: CableType = 'copper', id?: string): Link {
    if (this.links.size >= LIMITS.maxLinks) throw new TopologyError('Cable limit reached');
    if (a.device === b.device) throw new TopologyError('Cannot cable a device to itself');
    const da = this.devices.get(a.device);
    const db = this.devices.get(b.device);
    if (!da || !db) throw new TopologyError('Unknown device');
    const pa = da.ports[a.port];
    const pb = db.ports[b.port];
    if (!pa || !pb) throw new TopologyError('Unknown port');
    if (pa.link || pb.link) throw new TopologyError('Port already in use');
    const linkId = id ?? `l${this.linkCounter++}`;
    const match = /^l(\d+)$/.exec(linkId);
    if (match) this.linkCounter = Math.max(this.linkCounter, Number(match[1]) + 1);
    const link = new Link(linkId, { ...a }, { ...b }, cable);
    pa.link = link;
    pb.link = link;
    this.links.set(link.id, link);
    this.topologyChanged();
    return link;
  }

  disconnect(linkId: string): void {
    const link = this.links.get(linkId);
    if (!link) return;
    for (const end of [link.a, link.b]) {
      const port = this.devices.get(end.device)?.ports[end.port];
      if (port && port.link === link) port.link = null;
    }
    this.links.delete(linkId);
    this.topologyChanged();
  }

  /** First free port index on a device, or -1. */
  freePort(deviceId: string): number {
    const d = this.devices.get(deviceId);
    return d ? d.ports.findIndex((p) => !p.link) : -1;
  }

  // ---------- data plane ----------
  transmit(from: Device, portIndex: number, partial: Omit<Frame, 'uid'> & { uid?: number }): void {
    const frame: Frame = { ...partial, uid: this.frameCounter++ };
    const port = from.ports[portIndex];
    if (!port?.link) return this.reportDrop(from.id, 'no-link', { frame, detail: port?.name });
    if (!from.portUp(portIndex)) return this.reportDrop(from.id, 'link-down', { frame, detail: port.name });
    if (this.framesInFlight >= LIMITS.maxFramesInFlight) return this.reportDrop(from.id, 'sim-overload', { frame });
    const link = port.link;
    const dir = link.direction(from.id, portIndex);
    const spec = link.spec;
    const now = this.engine.now;
    const serialization = 1000 / spec.framesPerSecond;
    const depart = Math.max(now, link.busyUntil[dir]);
    if ((depart - now) / serialization >= LIMITS.maxQueuePerLink) {
      link.dropped++;
      return this.reportDrop(from.id, 'congestion', { frame, detail: port.name });
    }
    // Bigger frames take slightly longer to serialise.
    const sizeFactor = Math.max(1, pduSize(frame) / 500);
    link.busyUntil[dir] = depart + serialization * sizeFactor;
    const arrive = link.busyUntil[dir] + spec.latencyMs;
    const to = link.peer(from.id, portIndex)!;
    link.sent++;
    this.framesInFlight++;
    this.emit({ type: 'hop', frame, link: link.id, from: { device: from.id, port: portIndex }, to, start: depart, end: arrive });
    this.engine.schedule(
      arrive - now,
      () => {
        this.framesInFlight--;
        // The cable may have been cut or the far device removed while the frame was in flight.
        if (!this.links.has(link.id) || !link.up) return this.reportDrop(from.id, 'link-down', { frame });
        const target = this.devices.get(to.device);
        if (!target) return;
        target.receive(frame, to.port);
      },
      'frame',
    );
  }

  // ---------- reporting ----------
  emit(ev: SimEvent): void {
    this.bus.emit(ev);
  }

  reportDrop(device: string, reason: DropReason, opts: { frame?: Frame | undefined; packet?: IpPacket; detail?: string | undefined } = {}): void {
    const ev: SimEvent = { type: 'drop', device, reason, time: this.engine.now };
    if (opts.frame) ev.frame = opts.frame;
    if (opts.packet) ev.packet = opts.packet;
    if (opts.detail) ev.detail = opts.detail;
    this.emit(ev);
  }

  reportDeliver(device: string, packet: IpPacket): void {
    this.emit({ type: 'deliver', device, packet, time: this.engine.now });
  }

  /** Simulated hostile traffic reached an end host. */
  reportBreach(device: string, packet: IpPacket): void {
    this.emit({ type: 'breach', device, packet, time: this.engine.now });
  }

  log(device: string, text: string): void {
    this.emit({ type: 'log', device, text, time: this.engine.now });
  }

  configChanged(device: string): void {
    this.emit({ type: 'config', device, time: this.engine.now });
  }

  topologyChanged(): void {
    this.emit({ type: 'topology', time: this.engine.now });
  }

  /** Clear in-flight traffic and learned tables (keeps configuration). */
  resetTraffic(): void {
    this.engine.clear();
    this.framesInFlight = 0;
    for (const l of this.links.values()) l.busyUntil = [0, 0];
    for (const d of this.devices.values()) d.clearDynamicState();
  }
}
