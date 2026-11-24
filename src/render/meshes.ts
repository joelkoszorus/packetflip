/**
 * Procedural low-poly device models (no external assets) and text label sprites.
 * Labels are drawn with canvas fillText, which renders text literally (no HTML).
 */
import * as THREE from 'three';
import type { DeviceKind } from '../sim';
import type { TrafficClass } from '../sim/net/pdu';

export const TRAFFIC_COLORS: Record<TrafficClass, number> = {
  arp: 0xfacc15,
  icmp: 0x22d3ee,
  dns: 0xa78bfa,
  dhcp: 0xa3e635,
  http: 0x60a5fa,
  tcp: 0x94a3b8,
  data: 0xf472b6,
  hostile: 0xef4444,
};

export const TRAFFIC_LABELS: Record<TrafficClass, string> = {
  arp: 'ARP',
  icmp: 'ICMP (ping)',
  dns: 'DNS',
  dhcp: 'DHCP',
  http: 'HTTP / Web',
  tcp: 'TCP control',
  data: 'Voice / data',
  hostile: 'Attack (simulated)',
};

const mat = (color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15, flatShading: true, ...opts });

const shared = {
  shell: mat(0xcbd5e1),
  dark: mat(0x1e293b),
  darker: mat(0x0f172a),
  screen: mat(0x0ea5e9, { emissive: 0x0369a1, emissiveIntensity: 0.9 }),
  switch: mat(0x334155),
  router: mat(0x1d4ed8),
  firewall: mat(0xb45309),
  brick: mat(0x7c2d12),
  cloud: mat(0xe0f2fe, { roughness: 0.9 }),
  paper: mat(0xf8fafc),
  strip: mat(0x22c55e, { emissive: 0x16a34a, emissiveIntensity: 0.8 }),
};

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export interface DeviceModel {
  group: THREE.Group;
  height: number;
  /** Local positions of each port's LED / cable anchor. */
  portAnchors: THREE.Vector3[];
  leds: THREE.Mesh[];
}

function portRow(count: number, width: number, y: number, z: number): THREE.Vector3[] {
  if (count === 1) return [new THREE.Vector3(0, y, 0)];
  return Array.from({ length: count }, (_, i) => new THREE.Vector3(-width / 2 + (width * (i + 0.5)) / count, y, z));
}

export function buildDeviceModel(kind: DeviceKind, portCount: number): DeviceModel {
  const g = new THREE.Group();
  let height = 0.8;
  let anchors: THREE.Vector3[] = [new THREE.Vector3(0, 0.3, 0)];
  let ledParent = true;
  switch (kind) {
    case 'pc': {
      g.add(box(0.32, 0.75, 0.62, shared.shell, -0.55, 0, 0));
      g.add(box(0.08, 0.3, 0.08, shared.dark, 0.15, 0, 0));
      g.add(box(0.9, 0.55, 0.06, shared.dark, 0.15, 0.3, 0));
      g.add(box(0.82, 0.47, 0.01, shared.screen, 0.15, 0.34, 0.035));
      height = 0.9;
      anchors = [new THREE.Vector3(-0.55, 0.15, 0.32)];
      break;
    }
    case 'laptop': {
      g.add(box(0.9, 0.05, 0.6, shared.shell));
      const lid = new THREE.Group();
      lid.add(box(0.9, 0.58, 0.04, shared.dark, 0, 0, 0));
      lid.add(box(0.82, 0.5, 0.01, shared.screen, 0, 0.04, 0.025));
      lid.position.set(0, 0.05, -0.29);
      lid.rotation.x = -0.25;
      g.add(lid);
      height = 0.65;
      anchors = [new THREE.Vector3(0.45, 0.03, 0)];
      break;
    }
    case 'server': {
      g.add(box(0.8, 1.6, 0.8, shared.darker));
      for (let i = 0; i < 4; i++) g.add(box(0.6, 0.04, 0.01, shared.strip, 0, 0.25 + i * 0.35, 0.405));
      height = 1.6;
      anchors = [new THREE.Vector3(0, 0.15, 0.41)];
      break;
    }
    case 'printer': {
      g.add(box(0.9, 0.45, 0.7, shared.shell));
      g.add(box(0.6, 0.03, 0.35, shared.paper, 0, 0.45, 0.1));
      g.add(box(0.5, 0.06, 0.02, shared.dark, 0, 0.3, 0.355));
      height = 0.55;
      anchors = [new THREE.Vector3(0.45, 0.15, 0)];
      break;
    }
    case 'phone': {
      g.add(box(0.5, 0.12, 0.6, shared.dark));
      g.add(box(0.12, 0.1, 0.55, shared.shell, -0.17, 0.12, 0));
      g.add(box(0.22, 0.02, 0.2, shared.screen, 0.1, 0.12, -0.1));
      height = 0.3;
      anchors = [new THREE.Vector3(0, 0.05, -0.3)];
      break;
    }
    case 'switch': {
      g.add(box(2.0, 0.28, 0.9, shared.switch));
      height = 0.3;
      anchors = portRow(portCount, 1.8, 0.14, 0.46);
      break;
    }
    case 'router': {
      g.add(box(1.5, 0.36, 1.0, shared.router));
      for (const x of [-0.55, 0.55]) {
        const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6), shared.dark);
        ant.position.set(x, 0.7, -0.4);
        ant.castShadow = true;
        g.add(ant);
      }
      height = 0.9;
      anchors = portRow(portCount, 1.3, 0.18, 0.51);
      break;
    }
    case 'firewall': {
      g.add(box(1.5, 0.55, 1.0, shared.firewall));
      for (let r = 0; r < 2; r++) g.add(box(1.52, 0.03, 1.02, shared.brick, 0, 0.17 + r * 0.18, 0));
      height = 0.6;
      anchors = portRow(portCount, 1.2, 0.12, 0.51);
      break;
    }
    case 'cloud': {
      const puffs: [number, number, number, number][] = [
        [0, 1.4, 0, 0.9],
        [-0.9, 1.2, 0.1, 0.65],
        [0.9, 1.2, -0.1, 0.7],
        [0.3, 1.9, 0.1, 0.6],
        [-0.4, 1.8, -0.2, 0.55],
      ];
      for (const [x, y, z, r] of puffs) {
        const s = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), shared.cloud);
        s.position.set(x, y, z);
        s.castShadow = true;
        g.add(s);
      }
      g.add(box(0.12, 0.8, 0.12, shared.dark, 0, 0, 0));
      height = 2.4;
      anchors = [new THREE.Vector3(0, 0.2, 0)];
      ledParent = false;
      break;
    }
  }
  const leds: THREE.Mesh[] = [];
  if (ledParent && portCount > 1) {
    for (const a of anchors) {
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.03), new THREE.MeshBasicMaterial({ color: 0x334155 }));
      led.position.copy(a).add(new THREE.Vector3(0, 0.04, 0.005));
      g.add(led);
      leds.push(led);
    }
  }
  return { group: g, height, portAnchors: anchors, leds };
}

export const LABEL_FONT = "'Atkinson Hyperlegible', system-ui, -apple-system, 'Segoe UI', sans-serif";

/** A billboard text label. Text is drawn with fillText (never parsed as markup). */
export function makeLabel(lines: string[], opts: { color?: string; bg?: string; scale?: number } = {}): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontPx = 40;
  const pad = 14;
  ctx.font = `700 ${fontPx}px ${LABEL_FONT}`;
  const safe = lines.map((l) => l.slice(0, 40));
  const width = Math.max(...safe.map((l) => ctx.measureText(l).width)) + pad * 2;
  const lineH = fontPx * 1.2;
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(lineH * safe.length + pad);
  ctx.font = `700 ${fontPx}px ${LABEL_FONT}`;
  ctx.fillStyle = opts.bg ?? 'rgba(15, 23, 42, 0.78)';
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, 14);
  ctx.fill();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  safe.forEach((l, i) => {
    ctx.fillStyle = i === 0 ? opts.color ?? '#e2e8f0' : '#7dd3fc';
    if (i > 0) ctx.font = `400 ${fontPx * 0.8}px ${LABEL_FONT}`;
    ctx.fillText(l, canvas.width / 2, pad / 2 + lineH * (i + 0.5));
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const s = (opts.scale ?? 1) / 120;
  sprite.scale.set(canvas.width * s, canvas.height * s, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const material = (m as { material?: THREE.Material | THREE.Material[] }).material;
    const mats = Array.isArray(material) ? material : material ? [material] : [];
    for (const mt of mats) {
      if (Object.values(shared).includes(mt as THREE.MeshStandardMaterial)) continue;
      const map = (mt as THREE.SpriteMaterial).map;
      if (map) map.dispose();
      mt.dispose();
    }
  });
}
