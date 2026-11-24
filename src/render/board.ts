/**
 * The 3D isometric board: devices, cables, animated packets and effects.
 * Reads simulator state; all edits go through the GameStore.
 */
import * as THREE from 'three';
import { trafficClass, type SimEvent, type Device, L3Node, Host, formatIp, DROP_REASON_TEXT } from '../sim';
import type { GameStore } from '../game/store';
import { TRAFFIC_COLORS, buildDeviceModel, disposeObject, makeLabel, type DeviceModel } from './meshes';

const MAX_PACKETS = 900;
const FLOOR_SIZE = 90;

interface DeviceView {
  model: DeviceModel;
  label: THREE.Sprite;
  labelKey: string;
  hit: THREE.Mesh;
}

interface CableView {
  mesh: THREE.Mesh;
  curve: THREE.QuadraticBezierCurve3;
  key: string;
  aIsFrom: { device: string; port: number };
}

interface Flight {
  link: string;
  fromDevice: string;
  fromPort: number;
  start: number;
  end: number;
  color: THREE.Color;
}

interface Effect {
  sprite: THREE.Sprite;
  born: number;
  life: number;
}

export class BoardRenderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly renderer: THREE.WebGLRenderer;
  private devices = new Map<string, DeviceView>();
  private cables = new Map<string, CableView>();
  private flights: Flight[] = [];
  private effects: Effect[] = [];
  private activity = new Map<string, number>();
  private packets: THREE.InstancedMesh;
  private ringPool: THREE.Mesh[] = [];
  private newRing!: () => THREE.Mesh;
  private sourceRing: THREE.Mesh;
  private ghost: THREE.Mesh;
  private floor: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private target = new THREE.Vector3(0, 0, 0);
  private topDown = false;
  private offBus: (() => void) | null = null;
  private seenNetVersion = -1;
  private seenVersion = -1;
  private drag: { start: THREE.Vector3; origins: Map<string, { x: number; z: number }>; moved: boolean } | null = null;
  private marquee: { x0: number; y0: number; x1: number; y1: number; additive: boolean; el: HTMLDivElement } | null = null;
  private pan: { x: number; y: number } | null = null;
  private tmpMatrix = new THREE.Matrix4();
  private tmpPos = new THREE.Vector3();
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(
    private readonly container: HTMLElement,
    private readonly store: GameStore,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -200, 400);
    this.camera.zoom = 1;
    this.scene.background = new THREE.Color(0x0b1220);
    this.scene.fog = new THREE.Fog(0x0b1220, 90, 160);

    this.scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x1e293b, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(18, 30, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -40;
    sc.right = 40;
    sc.top = 40;
    sc.bottom = -40;
    this.scene.add(sun);

    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
      new THREE.MeshStandardMaterial({ color: 0x111c2e, roughness: 0.95 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    const grid = new THREE.GridHelper(FLOOR_SIZE, FLOOR_SIZE, 0x1f3352, 0x172640);
    grid.position.y = 0.002;
    this.scene.add(grid);

    this.packets = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(0.16, 0),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      MAX_PACKETS,
    );
    this.packets.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.packets.frustumCulled = false;
    for (let i = 0; i < MAX_PACKETS; i++) {
      this.packets.setMatrixAt(i, this.hidden);
      this.packets.setColorAt(i, new THREE.Color(0xffffff));
    }
    this.scene.add(this.packets);

    const ring = (color: number) => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(1.15, 1.3, 40),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.02;
      m.visible = false;
      this.scene.add(m);
      return m;
    };
    this.newRing = () => ring(0x38bdf8);
    this.sourceRing = ring(0xf59e0b);
    this.ghost = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.05, 1),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.35 }),
    );
    this.ghost.visible = false;
    this.scene.add(this.ghost);

    this.resize();
    this.placeCamera();
    window.addEventListener('resize', () => this.resize());
    this.bindInput();
  }

  // ---------------- camera ----------------

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    const aspect = w / h;
    // Half-height of the view in world units; smaller = closer.
    const view = aspect < 1 ? 14 : 11;
    this.camera.left = -view * aspect;
    this.camera.right = view * aspect;
    this.camera.top = view;
    this.camera.bottom = -view;
    this.camera.updateProjectionMatrix();
  }

  private placeCamera(): void {
    const t = this.target;
    if (this.topDown) this.camera.position.set(t.x, t.y + 60, t.z + 0.01);
    else this.camera.position.set(t.x + 40, t.y + 40, t.z + 40);
    this.camera.lookAt(t);
  }

  resetCamera(): void {
    this.target.set(0, 0, 0);
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.placeCamera();
  }

  toggleTopDown(): void {
    this.topDown = !this.topDown;
    this.placeCamera();
  }

  panBy(dx: number, dz: number): void {
    this.target.x = Math.max(-45, Math.min(45, this.target.x + dx));
    this.target.z = Math.max(-45, Math.min(45, this.target.z + dz));
    this.placeCamera();
  }

  zoomBy(factor: number): void {
    this.camera.zoom = Math.max(0.35, Math.min(3.5, this.camera.zoom * factor));
    this.camera.updateProjectionMatrix();
  }

  /** Screen position (CSS px) of a device, for HUD popovers. */
  screenOf(deviceId: string, center = false): { x: number; y: number } | null {
    const v = this.devices.get(deviceId);
    if (!v) return null;
    const p = v.model.group.position.clone();
    p.y += center ? v.model.height / 2 : v.model.height;
    p.project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
  }

  // ---------------- sync with the simulator ----------------

  private attachBus(): void {
    this.offBus?.();
    this.flights = [];
    this.offBus = this.store.net.bus.on((e) => this.onEvent(e));
  }

  private onEvent(e: SimEvent): void {
    if (e.type === 'hop') {
      if (this.flights.length >= MAX_PACKETS * 2) this.flights.shift();
      this.flights.push({
        link: e.link,
        fromDevice: e.from.device,
        fromPort: e.from.port,
        start: e.start,
        end: e.end,
        color: new THREE.Color(TRAFFIC_COLORS[trafficClass(e.frame)]),
      });
      this.activity.set(`${e.from.device}:${e.from.port}`, e.start);
      this.activity.set(`${e.to.device}:${e.to.port}`, e.end);
    } else if (e.type === 'drop') {
      this.spawnEffect(e.device, ['✖ ' + DROP_REASON_TEXT[e.reason]], '#fecaca', 'rgba(127, 29, 29, 0.85)');
    } else if (e.type === 'breach') {
      this.spawnEffect(e.device, ['⚠ BREACH'], '#fff', 'rgba(220, 38, 38, 0.95)');
    }
  }

  private spawnEffect(deviceId: string, lines: string[], color: string, bg: string): void {
    const v = this.devices.get(deviceId);
    if (!v) return;
    // Collapse duplicates: only one effect per device at a time.
    const existing = this.effects.find((f) => f.sprite.userData.device === deviceId);
    if (existing) {
      existing.born = performance.now();
      return;
    }
    if (this.effects.length > 24) return;
    const sprite = makeLabel(lines, { color, bg, scale: 0.85 });
    sprite.userData.device = deviceId;
    sprite.position.copy(v.model.group.position).add(new THREE.Vector3(0, v.model.height + 1.8, 0));
    this.scene.add(sprite);
    this.effects.push({ sprite, born: performance.now(), life: 1800 });
  }

  private labelLines(d: Device): string[] {
    const lines = [d.name];
    if (d instanceof Host) {
      lines.push(d.nic.ip !== null ? `${formatIp(d.nic.ip)}/${d.nic.prefix}` : d.dhcpEnabled ? 'DHCP…' : 'no IP');
    } else if (d instanceof L3Node && d.kind !== 'cloud') {
      const n = d.interfaces.filter((i) => i.ip !== null).length;
      lines.push(n ? `${n} IP interface${n === 1 ? '' : 's'}` : 'unconfigured');
    }
    return lines;
  }

  private syncDevices(): void {
    const net = this.store.net;
    for (const [id, v] of this.devices) {
      if (!net.devices.has(id)) {
        this.scene.remove(v.model.group, v.label);
        disposeObject(v.model.group);
        disposeObject(v.label);
        this.devices.delete(id);
      }
    }
    for (const d of net.devices.values()) {
      let v = this.devices.get(d.id);
      if (!v) {
        const model = buildDeviceModel(d.kind, d.ports.length);
        const size = new THREE.Box3().setFromObject(model.group).getSize(new THREE.Vector3());
        const hit = new THREE.Mesh(
          new THREE.BoxGeometry(Math.max(1.2, size.x), Math.max(0.6, size.y), Math.max(1.2, size.z)),
          new THREE.MeshBasicMaterial({ visible: false }),
        );
        hit.position.y = Math.max(0.6, size.y) / 2;
        hit.userData.device = d.id;
        model.group.add(hit);
        this.scene.add(model.group);
        const label = makeLabel(this.labelLines(d));
        this.scene.add(label);
        v = { model, label, labelKey: '', hit };
        this.devices.set(d.id, v);
      }
      v.model.group.position.set(d.position.x, 0, d.position.z);
      const lines = this.labelLines(d);
      const key = lines.join('|');
      if (key !== v.labelKey) {
        this.scene.remove(v.label);
        disposeObject(v.label);
        v.label = makeLabel(lines);
        this.scene.add(v.label);
        v.labelKey = key;
      }
      v.label.position.set(d.position.x, v.model.height + 0.75, d.position.z);
    }
  }

  private anchor(device: string, port: number): THREE.Vector3 {
    const v = this.devices.get(device);
    const d = this.store.net.device(device);
    if (!v || !d) return new THREE.Vector3();
    const local = v.model.portAnchors[port] ?? v.model.portAnchors[0] ?? new THREE.Vector3();
    return local.clone().add(new THREE.Vector3(d.position.x, 0, d.position.z));
  }

  private syncCables(): void {
    const net = this.store.net;
    for (const [id, c] of this.cables) {
      if (!net.links.has(id)) {
        this.scene.remove(c.mesh);
        disposeObject(c.mesh);
        this.cables.delete(id);
      }
    }
    for (const l of net.links.values()) {
      const da = net.device(l.a.device);
      const db = net.device(l.b.device);
      if (!da || !db) continue;
      const up = da.portUp(l.a.port) && db.portUp(l.b.port);
      const key = `${da.position.x},${da.position.z},${db.position.x},${db.position.z},${up},${l.cable}`;
      const existing = this.cables.get(l.id);
      if (existing && existing.key === key) continue;
      if (existing) {
        this.scene.remove(existing.mesh);
        disposeObject(existing.mesh);
      }
      const a = this.anchor(l.a.device, l.a.port);
      const b = this.anchor(l.b.device, l.b.port);
      const mid = a.clone().lerp(b, 0.5);
      mid.y += 0.4 + a.distanceTo(b) * 0.12;
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const color = !up ? 0xdc2626 : l.cable === 'fiber' ? 0xf97316 : 0x64748b;
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 28, l.cable === 'fiber' ? 0.045 : 0.06, 6, false),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, transparent: !up, opacity: up ? 1 : 0.55 }),
      );
      mesh.castShadow = true;
      mesh.userData.link = l.id;
      this.scene.add(mesh);
      this.cables.set(l.id, { mesh, curve, key, aIsFrom: { ...l.a } });
    }
  }

  // ---------------- per-frame ----------------

  frame(): void {
    const store = this.store;
    if (store.netVersion !== this.seenNetVersion) {
      this.seenNetVersion = store.netVersion;
      for (const v of this.devices.values()) {
        this.scene.remove(v.model.group, v.label);
        disposeObject(v.model.group);
      }
      this.devices.clear();
      for (const c of this.cables.values()) this.scene.remove(c.mesh);
      this.cables.clear();
      this.attachBus();
      this.seenVersion = -1;
    }
    if (store.version !== this.seenVersion) {
      this.seenVersion = store.version;
      this.syncDevices();
      this.syncCables();
    }
    this.updatePackets();
    this.updateLeds();
    this.updateEffects();
    this.updateRings();
    this.renderer.render(this.scene, this.camera);
  }

  private updatePackets(): void {
    const now = this.store.net.engine.now;
    let n = 0;
    const keep: Flight[] = [];
    for (const f of this.flights) {
      if (now > f.end) continue;
      keep.push(f);
      if (now < f.start || n >= MAX_PACKETS) continue;
      const cable = this.cables.get(f.link);
      if (!cable) continue;
      let t = (now - f.start) / Math.max(1, f.end - f.start);
      const forward = cable.aIsFrom.device === f.fromDevice && cable.aIsFrom.port === f.fromPort;
      if (!forward) t = 1 - t;
      cable.curve.getPoint(t, this.tmpPos);
      this.tmpPos.y += 0.12;
      this.tmpMatrix.makeRotationY(now / 300).setPosition(this.tmpPos);
      this.packets.setMatrixAt(n, this.tmpMatrix);
      this.packets.setColorAt(n, f.color);
      n++;
    }
    this.flights = keep;
    for (let i = n; i < this.packets.count; i++) {
      this.packets.setMatrixAt(i, this.hidden);
      if (i > n + 4 && i > this.lastPacketCount) break;
    }
    this.lastPacketCount = n;
    this.packets.instanceMatrix.needsUpdate = true;
    if (this.packets.instanceColor) this.packets.instanceColor.needsUpdate = true;
  }
  private lastPacketCount = 0;

  private updateLeds(): void {
    const net = this.store.net;
    const now = net.engine.now;
    for (const [id, v] of this.devices) {
      const d = net.device(id);
      if (!d) continue;
      v.model.leds.forEach((led, i) => {
        const port = d.ports[i];
        const m = led.material as THREE.MeshBasicMaterial;
        if (!port) return;
        if (!port.enabled) m.color.setHex(0x7f1d1d);
        else if (!d.portUp(i)) m.color.setHex(0x334155);
        else {
          const last = this.activity.get(`${id}:${i}`) ?? -1e9;
          m.color.setHex(Math.abs(now - last) < 160 ? 0xfde047 : 0x22c55e);
        }
      });
    }
  }

  private updateEffects(): void {
    const t = performance.now();
    this.effects = this.effects.filter((e) => {
      const age = (t - e.born) / e.life;
      if (age >= 1) {
        this.scene.remove(e.sprite);
        disposeObject(e.sprite);
        return false;
      }
      (e.sprite.material as THREE.SpriteMaterial).opacity = 1 - age * age;
      e.sprite.position.y += 0.004;
      return true;
    });
  }

  private updateRings(): void {
    // One ring per selected device; the primary (inspected) one is brightest.
    const ids = [...this.store.group];
    while (this.ringPool.length < ids.length) this.ringPool.push(this.newRing());
    this.ringPool.forEach((r, i) => {
      const id = ids[i];
      const d = id !== undefined ? this.store.net.device(id) : undefined;
      r.visible = !!d;
      if (!d) return;
      r.position.set(d.position.x, 0.02, d.position.z);
      (r.material as THREE.MeshBasicMaterial).opacity = id === this.store.selected ? 0.95 : 0.5;
    });
    const tool = this.store.tool;
    const srcId = tool.kind === 'cable' ? tool.from?.device : tool.kind === 'ping' ? tool.from : undefined;
    const src = srcId ? this.store.net.device(srcId) : undefined;
    this.sourceRing.visible = !!src;
    if (src) this.sourceRing.position.set(src.position.x, 0.03, src.position.z);
    this.ghost.visible = this.ghost.visible && tool.kind === 'place';
  }

  // ---------------- box selection ----------------

  private updateMarquee(): void {
    const m = this.marquee;
    if (!m) return;
    const s = m.el.style;
    s.left = `${Math.min(m.x0, m.x1)}px`;
    s.top = `${Math.min(m.y0, m.y1)}px`;
    s.width = `${Math.abs(m.x1 - m.x0)}px`;
    s.height = `${Math.abs(m.y1 - m.y0)}px`;
  }

  private finishMarquee(): void {
    const m = this.marquee;
    if (!m) return;
    this.marquee = null;
    m.el.remove();
    const left = Math.min(m.x0, m.x1);
    const right = Math.max(m.x0, m.x1);
    const top = Math.min(m.y0, m.y1);
    const bottom = Math.max(m.y0, m.y1);
    if (right - left < 5 && bottom - top < 5) {
      if (!m.additive) this.store.select(null);
      return;
    }
    const hits = [...this.devices.keys()].filter((id) => {
      const p = this.screenOf(id, true);
      return !!p && p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
    });
    const ids = m.additive ? [...this.store.group, ...hits] : hits;
    const keep = this.store.selected !== null && ids.includes(this.store.selected) ? this.store.selected : (hits[0] ?? null);
    this.store.setGroup(ids, keep);
  }

  // ---------------- input ----------------

  private setPointer(ev: PointerEvent | WheelEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private pickDevice(): string | null {
    const hits = this.raycaster.intersectObjects([...this.devices.values()].map((v) => v.hit), false);
    return (hits[0]?.object.userData.device as string | undefined) ?? null;
  }

  private pickCable(): string | null {
    const hits = this.raycaster.intersectObjects([...this.cables.values()].map((c) => c.mesh), false);
    return (hits[0]?.object.userData.link as string | undefined) ?? null;
  }

  private floorPoint(): THREE.Vector3 | null {
    const hit = this.raycaster.intersectObject(this.floor, false)[0];
    return hit ? hit.point : null;
  }

  private bindInput(): void {
    const el = this.renderer.domElement;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomBy(e.deltaY > 0 ? 0.9 : 1.1);
    }, { passive: false });

    el.addEventListener('pointerdown', (e) => {
      this.setPointer(e);
      if (e.button === 2 || e.button === 1) {
        this.pan = { x: e.clientX, y: e.clientY };
        el.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;
      const store = this.store;
      const tool = store.tool;
      const device = this.pickDevice();
      switch (tool.kind) {
        case 'select': {
          const additive = e.shiftKey || e.ctrlKey || e.metaKey;
          if (device) {
            if (additive) store.toggleInGroup(device);
            else if (store.group.has(device) && store.group.size > 1) store.setGroup(store.group, device);
            else store.select(device);
            const start = this.floorPoint();
            if (start && store.group.has(device)) {
              const origins = new Map<string, { x: number; z: number }>();
              for (const id of store.group) {
                const d = store.net.device(id);
                if (d) origins.set(id, { ...d.position });
              }
              this.drag = { start: start.clone(), origins, moved: false };
            }
          } else {
            // Empty floor: start a selection box (a plain click clears the selection).
            const box = document.createElement('div');
            box.className = 'marquee';
            this.container.appendChild(box);
            this.marquee = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, additive, el: box };
            this.updateMarquee();
          }
          el.setPointerCapture(e.pointerId);
          break;
        }
        case 'place': {
          const p = this.floorPoint();
          if (p && !device) store.placeDevice(tool.device, p.x, p.z);
          break;
        }
        case 'cable':
          if (device) store.requestPortPick(device, e.clientX, e.clientY);
          break;
        case 'delete': {
          if (device) store.deleteDevice(device);
          else {
            const link = this.pickCable();
            if (link) store.unlink(link);
          }
          break;
        }
        case 'unlink': {
          const link = this.pickCable();
          if (link) store.unlink(link);
          break;
        }
        case 'ping':
          if (device) store.pingClick(device);
          break;
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (this.pan) {
        const dx = e.clientX - this.pan.x;
        const dy = e.clientY - this.pan.y;
        this.pan = { x: e.clientX, y: e.clientY };
        const scale = (this.camera.right - this.camera.left) / this.renderer.domElement.clientWidth / this.camera.zoom;
        if (this.topDown) this.panBy(-dx * scale, -dy * scale);
        else {
          // Screen axes → ground axes for the isometric view.
          const k = scale * 0.7071;
          this.panBy(-(dx + dy * 1.732) * k, (dx - dy * 1.732) * k);
        }
        return;
      }
      this.setPointer(e);
      if (this.marquee) {
        this.marquee.x1 = e.clientX;
        this.marquee.y1 = e.clientY;
        this.updateMarquee();
        return;
      }
      if (this.drag) {
        const p = this.floorPoint();
        if (p) {
          const dx = Math.round(p.x - this.drag.start.x);
          const dz = Math.round(p.z - this.drag.start.z);
          if (dx !== 0 || dz !== 0 || this.drag.moved) {
            this.drag.moved = true;
            this.store.moveGroup(this.drag.origins, dx, dz);
          }
        }
        return;
      }
      if (this.store.tool.kind === 'place') {
        const p = this.floorPoint();
        this.ghost.visible = !!p;
        if (p) this.ghost.position.set(Math.round(p.x), 0.03, Math.round(p.z));
      }
      const over = this.pickDevice() ?? (this.store.tool.kind === 'unlink' || this.store.tool.kind === 'delete' ? this.pickCable() : null);
      el.style.cursor = over ? 'pointer' : this.store.tool.kind === 'place' ? 'copy' : 'default';
    });

    const end = (e: PointerEvent) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      this.pan = null;
      this.drag = null;
      if (this.marquee) this.finishMarquee();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
}
