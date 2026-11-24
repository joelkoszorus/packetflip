import type { Mac } from '../net/addr';
import type { Frame } from '../net/pdu';
import type { DropReason } from '../events';
import type { Network } from '../network';
import type { Link } from '../link';

export type DeviceKind = 'pc' | 'laptop' | 'server' | 'printer' | 'phone' | 'switch' | 'router' | 'firewall' | 'cloud';

export interface Port {
  index: number;
  name: string;
  mac: Mac;
  /** Admin state ("shutdown" / "no shutdown"). */
  enabled: boolean;
  link: Link | null;
  description: string;
}

export interface Position {
  x: number;
  z: number;
}

export abstract class Device {
  name: string;
  position: Position;
  powered = true;
  readonly ports: Port[] = [];
  protected net!: Network;

  /** The network this device belongs to (read-only access for tools and UI). */
  get network(): Network {
    return this.net;
  }

  constructor(
    readonly id: string,
    readonly kind: DeviceKind,
    name: string,
    position: Position,
  ) {
    this.name = name;
    this.position = { ...position };
  }

  /** Called by Network when the device is added. */
  attach(net: Network, portNames: string[]): void {
    this.net = net;
    for (const [index, name] of portNames.entries()) {
      this.ports.push({ index, name, mac: net.nextMac(), enabled: true, link: null, description: '' });
    }
    this.onAttach();
  }

  protected onAttach(): void {}

  /** A port is operationally up if admin-enabled, cabled, the cable is up, and the far end is enabled. */
  portUp(index: number): boolean {
    const port = this.ports[index];
    if (!port || !port.enabled || !port.link || !port.link.up || !this.powered) return false;
    const peer = port.link.peer(this.id, index);
    if (!peer) return false;
    const other = this.net.device(peer.device);
    return !!other && other.powered && !!other.ports[peer.port]?.enabled;
  }

  portByName(name: string): Port | undefined {
    const n = name.toLowerCase();
    return this.ports.find((p) => p.name.toLowerCase() === n);
  }

  /** Entry point for frames arriving from a cable. */
  abstract receive(frame: Frame, port: number): void;

  protected transmit(port: number, frame: Omit<Frame, 'uid'> & { uid?: number }): void {
    this.net.transmit(this, port, frame);
  }

  protected drop(reason: DropReason, frame?: Frame, detail?: string): void {
    this.net.reportDrop(this.id, reason, { frame, detail });
  }

  protected log(text: string): void {
    this.net.log(this.id, text);
  }

  protected get now(): number {
    return this.net.engine.now;
  }

  /** Remove learned state (ARP caches, MAC tables) e.g. on reset. */
  clearDynamicState(): void {}

  abstract serializeConfig(): unknown;
  abstract applyConfig(config: unknown): void;
}
