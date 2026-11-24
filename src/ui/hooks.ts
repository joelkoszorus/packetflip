import { useEffect, useReducer } from 'preact/hooks';
import { store, type GameStore } from '../game/store';
import { parseIp, parseMask, type Ip } from '../sim';

/** Re-render whenever the store changes. */
export function useStore(): GameStore {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => store.subscribe(() => bump(undefined)), []);
  return store;
}

/** Re-render on an interval (for live counters like the sim clock and flow stats). */
export function useTicker(ms: number): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const t = setInterval(() => bump(undefined), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/**
 * Keydown handler for form inputs: Enter clicks the nearest [data-submit] button
 * inside the closest [data-submit-scope]; with no such button it commits the
 * field by blurring it (fields that save on blur/change). Other keys are kept
 * away from the global game shortcuts.
 */
export function submitOnEnter(e: KeyboardEvent): void {
  e.stopPropagation();
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  const btn = el.closest('[data-submit-scope]')?.querySelector<HTMLButtonElement>('[data-submit]');
  if (btn && !btn.disabled) btn.click();
  else el.blur();
}

export const NAME_RE = /^[\p{L}\p{N} ._-]{1,32}$/u;

export function ipOrEmpty(text: string): { ok: boolean; ip: Ip | null } {
  const t = text.trim();
  if (t === '') return { ok: true, ip: null };
  const ip = parseIp(t);
  return { ok: ip !== null, ip };
}

export function maskInput(text: string): number | null {
  const t = text.trim();
  if (/^\d{1,2}$/.test(t)) return parseMask('/' + t);
  return parseMask(t);
}

export function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
