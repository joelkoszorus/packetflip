// Atkinson Hyperlegible (Braille Institute, OFL-1.1), self-hosted: bundled into the site, no third-party request.
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import './ui/styles.css';
import { h, render } from 'preact';
import { store } from './game/store';
import { autosave } from './game/progress';
import { BoardRenderer } from './render/board';
import { App } from './ui/App';
import { decodeShare, shareFromHash } from './persistence/share';
import { restoreLayout } from './ui/Resize';
import { LABEL_FONT } from './render/meshes';

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function fatal(message: string): void {
  const root = document.getElementById('hud-root')!;
  const box = document.createElement('div');
  box.className = 'fatal';
  box.textContent = message;
  root.replaceChildren(box);
}

async function boot(): Promise<void> {
  if (!webglAvailable()) {
    fatal('Packet Flip needs WebGL. Try a recent Chrome, Edge, Firefox or Safari, or enable hardware acceleration.');
    return;
  }
  restoreLayout();
  // 3D labels are drawn onto canvases, so wait (briefly) for the font before the first frame.
  try {
    await Promise.race([
      Promise.all([document.fonts.load(`400 16px ${LABEL_FONT}`), document.fonts.load(`700 16px ${LABEL_FONT}`)]),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch {
    /* fall back to system fonts */
  }
  const canvasRoot = document.getElementById('canvas-root')!;
  const board = new BoardRenderer(canvasRoot, store);
  render(h(App, { board }), document.getElementById('hud-root')!);

  // A shared network in the URL fragment: validate it, then ask before opening.
  const shared = shareFromHash(location.hash);
  if (shared) {
    try {
      store.pendingShare = await decodeShare(shared);
      store.modal = 'share-import';
    } catch (err) {
      store.showToast(`That share link could not be opened: ${err instanceof Error ? err.message : 'invalid'}`, 'bad');
      history.replaceState(null, '', location.pathname + location.search);
    }
    store.changed();
  }

  let last = performance.now();
  let lastSave = last;
  const loop = (now: number) => {
    const dt = now - last;
    last = now;
    try {
      store.tick(dt);
      board.frame();
    } catch (err) {
      console.error(err);
    }
    if (store.mode === 'sandbox' && store.net.devices.size > 0 && now - lastSave > 15_000) {
      lastSave = now;
      try {
        autosave(store.snapshot());
      } catch {
        /* ignore */
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // Expose a read-only handle for debugging in dev builds only.
  if (import.meta.env.DEV) (window as unknown as { packetFlip: unknown }).packetFlip = { store };
}

void boot();
