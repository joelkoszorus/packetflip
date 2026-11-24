import { Network } from '../sim';
import type { TrafficManager } from '../sim/traffic/flows';
import { SAVE_FORMAT, SAVE_VERSION, parseSave, validateSave, type SaveFile, type SavedFlow } from './validate';

export function serializeNetwork(net: Network, title = 'Untitled network', traffic?: TrafficManager): SaveFile {
  const devices = [...net.devices.values()].map((d) => ({
    id: d.id,
    kind: d.kind,
    name: d.name,
    x: Math.round(d.position.x * 100) / 100,
    z: Math.round(d.position.z * 100) / 100,
    powered: d.powered,
    ports: d.ports.map((p) => ({ enabled: p.enabled, description: p.description })),
    config: d.serializeConfig(),
  }));
  const links = [...net.links.values()].map((l) => ({ id: l.id, a: { ...l.a }, b: { ...l.b }, cable: l.cable, up: l.up }));
  const flows: SavedFlow[] = traffic
    ? [...traffic.flows.values()].map((f) => ({ kind: f.kind, from: f.from, to: f.to, everyMs: f.everyMs, enabled: f.enabled }))
    : [];
  // Round-trip through the validator so we never write something we could not read back.
  return validateSave(JSON.parse(JSON.stringify({ format: SAVE_FORMAT, version: SAVE_VERSION, title, devices, links, flows })));
}

/** Build a live Network from a validated save. */
export function buildNetwork(save: SaveFile): Network {
  const net = new Network();
  for (const d of save.devices) {
    const dev = net.addDevice(d.kind, { id: d.id, name: d.name, position: { x: d.x, z: d.z } });
    dev.powered = d.powered;
    d.ports.forEach((p, i) => {
      const port = dev.ports[i];
      if (port) {
        port.enabled = p.enabled;
        port.description = p.description;
      }
    });
    dev.applyConfig(d.config);
  }
  for (const l of save.links) {
    const link = net.connect(l.a, l.b, l.cable, l.id);
    link.up = l.up;
  }
  return net;
}

/** Deep copy of a network's configuration and cabling (no in-flight traffic or learned state). */
export function cloneNetwork(net: Network): Network {
  return buildNetwork(serializeNetwork(net));
}

export function saveToText(save: SaveFile): string {
  return JSON.stringify(save, null, 1);
}

export function loadFromText(text: string): SaveFile {
  return parseSave(text);
}
