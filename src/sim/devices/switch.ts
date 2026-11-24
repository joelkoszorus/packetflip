/**
 * Layer-2 switch: MAC learning, access/trunk ports, 802.1Q VLANs.
 * There is no spanning tree yet, so a cabling loop floods until the
 * l2hops safety cap drops the frame with reason 'l2-loop'.
 */
import { Device } from './device';
import { BROADCAST_MAC, type Mac } from '../net/addr';
import type { Frame } from '../net/pdu';
import { LIMITS } from '../limits';

export const MAC_AGING_MS = 300_000;

export interface SwitchPortConfig {
  mode: 'access' | 'trunk';
  accessVlan: number;
  nativeVlan: number;
  /** null = all VLANs allowed */
  allowedVlans: number[] | null;
}

export interface SwitchConfig {
  vlans: { id: number; name: string }[];
  ports: (SwitchPortConfig & { enabled: boolean; description: string })[];
}

interface MacEntry {
  port: number;
  expires: number;
}

export function isValidVlanId(id: number): boolean {
  return Number.isInteger(id) && id >= 1 && id <= 4094;
}

export class Switch extends Device {
  readonly vlans = new Map<number, string>([[1, 'default']]);
  portConfig: SwitchPortConfig[] = [];
  readonly macTable = new Map<string, MacEntry>();

  protected override onAttach(): void {
    this.portConfig = this.ports.map(() => ({ mode: 'access', accessVlan: 1, nativeVlan: 1, allowedVlans: null }));
  }

  /** Does this port carry the given VLAN? */
  carries(port: number, vlan: number): boolean {
    const pc = this.portConfig[port];
    if (!pc) return false;
    if (pc.mode === 'access') return pc.accessVlan === vlan;
    return pc.allowedVlans === null || pc.allowedVlans.includes(vlan);
  }

  receive(frame: Frame, portIndex: number): void {
    if (!this.powered) return;
    const pc = this.portConfig[portIndex];
    if (!pc) return;

    // 1. Classify the frame into a VLAN.
    let vlan: number;
    if (pc.mode === 'access') {
      if (frame.vlan !== undefined) return this.drop('tagged-on-access', frame, `VLAN ${frame.vlan}`);
      vlan = pc.accessVlan;
    } else {
      vlan = frame.vlan ?? pc.nativeVlan;
      if (!this.carries(portIndex, vlan)) return this.drop('vlan-not-allowed', frame, `VLAN ${vlan}`);
    }
    if (!this.vlans.has(vlan)) return this.drop('vlan-missing', frame, `VLAN ${vlan}`);
    if (frame.l2hops >= LIMITS.maxL2Hops) return this.drop('l2-loop', frame);

    // 2. Learn the source MAC.
    this.macTable.set(this.key(vlan, frame.src), { port: portIndex, expires: this.now + MAC_AGING_MS });

    // 3. Forward, flood or filter.
    const fwd = { ...frame, l2hops: frame.l2hops + 1 };
    if (frame.dst !== BROADCAST_MAC) {
      const entry = this.macTable.get(this.key(vlan, frame.dst));
      if (entry && entry.expires > this.now) {
        if (entry.port !== portIndex && this.portUp(entry.port)) this.egress(entry.port, vlan, fwd);
        return; // same port → filter
      }
    }
    for (const p of this.ports) {
      if (p.index === portIndex || !this.carries(p.index, vlan) || !this.portUp(p.index)) continue;
      this.egress(p.index, vlan, fwd);
    }
  }

  private egress(port: number, vlan: number, frame: Frame): void {
    const pc = this.portConfig[port]!;
    const tagged = pc.mode === 'trunk' && vlan !== pc.nativeVlan;
    const { vlan: _old, ...rest } = frame;
    this.transmit(port, tagged ? { ...rest, vlan } : rest);
  }

  private key(vlan: number, mac: Mac): string {
    return `${vlan}|${mac}`;
  }

  /** Entries for `show mac address-table`. */
  macEntries(): { vlan: number; mac: Mac; port: string }[] {
    const out: { vlan: number; mac: Mac; port: string }[] = [];
    for (const [key, e] of this.macTable) {
      if (e.expires <= this.now) continue;
      const [v, mac] = key.split('|') as [string, Mac];
      out.push({ vlan: Number(v), mac, port: this.ports[e.port]?.name ?? '?' });
    }
    return out.sort((a, b) => a.vlan - b.vlan || a.port.localeCompare(b.port));
  }

  override clearDynamicState(): void {
    this.macTable.clear();
  }

  serializeConfig(): SwitchConfig {
    return {
      vlans: [...this.vlans].map(([id, name]) => ({ id, name })),
      ports: this.ports.map((p, i) => ({
        ...this.portConfig[i]!,
        allowedVlans: this.portConfig[i]!.allowedVlans ? [...this.portConfig[i]!.allowedVlans!] : null,
        enabled: p.enabled,
        description: p.description,
      })),
    };
  }

  applyConfig(raw: unknown): void {
    const c = raw as SwitchConfig;
    this.vlans.clear();
    for (const v of c.vlans) this.vlans.set(v.id, v.name);
    if (!this.vlans.has(1)) this.vlans.set(1, 'default');
    c.ports.forEach((p, i) => {
      if (!this.ports[i]) return;
      this.portConfig[i] = {
        mode: p.mode,
        accessVlan: p.accessVlan,
        nativeVlan: p.nativeVlan,
        allowedVlans: p.allowedVlans ? [...p.allowedVlans] : null,
      };
      this.ports[i]!.enabled = p.enabled;
      this.ports[i]!.description = p.description;
    });
  }
}
