/**
 * Drag handles that resize HUD panels by updating CSS custom properties on :root.
 * Sizes are remembered per browser (a convenience only; failures are ignored).
 */
const LAYOUT_KEY = 'packet-flip:layout:v1';

type SizeVar = '--right-w' | '--bottom-h';

const LIMITS: Record<SizeVar, { min: number; max: () => number }> = {
  '--right-w': { min: 300, max: () => Math.max(320, Math.min(1000, window.innerWidth * 0.6)) },
  '--bottom-h': { min: 110, max: () => Math.max(140, window.innerHeight * 0.7) },
};

function clamp(v: SizeVar, px: number): number {
  return Math.round(Math.max(LIMITS[v].min, Math.min(LIMITS[v].max(), px)));
}

function readLayout(): Partial<Record<SizeVar, number>> {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw || raw.length > 200) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Partial<Record<SizeVar, number>> = {};
    for (const v of Object.keys(LIMITS) as SizeVar[]) {
      const n = (parsed as Record<string, unknown>)[v];
      if (typeof n === 'number' && Number.isFinite(n)) out[v] = n;
    }
    return out;
  } catch {
    return {};
  }
}

function saveSize(v: SizeVar, px: number | null): void {
  try {
    const layout = readLayout();
    if (px === null) delete layout[v];
    else layout[v] = px;
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* storage blocked: sizes just won't be remembered */
  }
}

function apply(v: SizeVar, px: number | null): void {
  if (px === null) document.documentElement.style.removeProperty(v);
  else document.documentElement.style.setProperty(v, `${clamp(v, px)}px`);
}

/** Restore saved panel sizes (call once at startup). */
export function restoreLayout(): void {
  for (const [v, px] of Object.entries(readLayout()) as [SizeVar, number][]) apply(v, px);
}

function current(v: SizeVar, el: HTMLElement | null): number {
  const rect = el?.parentElement?.getBoundingClientRect();
  if (!rect) return 0;
  return v === '--right-w' ? rect.width : rect.height;
}

/**
 * A handle on the left edge of a right-docked panel ("--right-w") or the top
 * edge of a bottom-docked panel ("--bottom-h"). Double-click resets the size.
 */
export function ResizeHandle({ size, label }: { size: SizeVar; label: string }) {
  const horizontal = size === '--right-w';
  const fromPointer = (e: PointerEvent) =>
    horizontal ? window.innerWidth - e.clientX - 10 : window.innerHeight - e.clientY - 10;

  return (
    <div
      class={horizontal ? 'resize-handle vertical-edge' : 'resize-handle horizontal-edge'}
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-label={`Resize ${label} (drag, arrow keys, double-click to reset)`}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);
        document.body.classList.add(horizontal ? 'resizing-x' : 'resizing-y');
        const move = (ev: PointerEvent) => apply(size, fromPointer(ev));
        const up = (ev: PointerEvent) => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          document.body.classList.remove('resizing-x', 'resizing-y');
          saveSize(size, clamp(size, fromPointer(ev)));
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
      onDblClick={() => {
        apply(size, null);
        saveSize(size, null);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        const grow = horizontal ? 'ArrowLeft' : 'ArrowUp';
        const shrink = horizontal ? 'ArrowRight' : 'ArrowDown';
        if (e.key !== grow && e.key !== shrink) return;
        e.preventDefault();
        const px = clamp(size, current(size, e.currentTarget as HTMLElement) + (e.key === grow ? 24 : -24));
        apply(size, px);
        saveSize(size, px);
      }}
    />
  );
}
