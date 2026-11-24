/**
 * Per-browser progress (stars per scenario) and sandbox autosave.
 * localStorage is untrusted input: every read is validated and every access
 * is wrapped so private mode / blocked storage never breaks the game.
 */
import { parseSave, safeJsonParse, type SaveFile } from '../persistence/validate';

const STARS_KEY = 'packet-flip:stars:v1';
const AUTOSAVE_KEY = 'packet-flip:autosave:v1';
const ID_RE = /^[a-z0-9-]{1,40}$/;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full or blocked: progress is best-effort */
  }
}

export function loadStars(): Record<string, number> {
  const raw = read(STARS_KEY);
  if (!raw) return {};
  try {
    const parsed = safeJsonParse(raw, 16_384);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = Object.create(null);
    for (const [k, v] of Object.entries(parsed)) {
      if (ID_RE.test(k) && Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3) out[k] = v as number;
    }
    return out;
  } catch {
    return {};
  }
}

export function recordStars(id: string, stars: number): void {
  if (!ID_RE.test(id)) return;
  const all = loadStars();
  if ((all[id] ?? 0) >= stars) return;
  all[id] = stars;
  write(STARS_KEY, JSON.stringify(all));
}

export function autosave(save: SaveFile): void {
  write(AUTOSAVE_KEY, JSON.stringify(save));
}

export function loadAutosave(): SaveFile | null {
  const raw = read(AUTOSAVE_KEY);
  if (!raw) return null;
  try {
    return parseSave(raw);
  } catch {
    return null;
  }
}
