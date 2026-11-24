/**
 * NetOS command matching engine: abbreviations ("sh ip int br"), parameter
 * validation, ambiguity detection, tab completion and "?" help.
 * Pure and headless; every input is length-capped and validated.
 */
import { parseIp, parseMask, type Ip } from '../sim/net/addr';
import { normalizeHostname } from '../sim/services/apps';

export const MAX_LINE = 256;
export const MAX_TOKEN = 64;

export type ParamKind = 'ip' | 'mask' | 'num' | 'vlan' | 'word' | 'iface' | 'rest' | 'vlanlist' | 'target';

export type Element =
  | { type: 'lit'; words: string[]; name?: string }
  | { type: 'param'; kind: ParamKind; name: string; optional: boolean };

export interface Arg {
  ip?: Ip;
  prefix?: number;
  num?: number;
  text: string;
  list?: number[] | null;
}

export type Args = Record<string, Arg>;

export function parseSyntax(syntax: string): Element[] {
  return syntax
    .trim()
    .split(/\s+/)
    .map((tok): Element => {
      const param = /^<(\w+):(\w+)(\?)?>$/.exec(tok);
      if (param) return { type: 'param', kind: param[1] as ParamKind, name: param[2]!, optional: !!param[3] };
      const alt = /^\{([\w|-]+):(\w+)\}$/.exec(tok);
      if (alt) return { type: 'lit', words: alt[1]!.split('|'), name: alt[2]! };
      return { type: 'lit', words: [tok] };
    });
}

export const PARAM_HINT: Record<ParamKind, string> = {
  ip: 'A.B.C.D',
  mask: 'A.B.C.D or /prefix',
  num: '<0-65535>',
  vlan: '<1-4094>',
  word: 'WORD',
  iface: 'interface name (e.g. ge0, ge0.10, port1)',
  rest: 'LINE',
  vlanlist: 'all | 1,10,20-30',
  target: 'IP address or hostname',
};

export function parseVlanList(text: string): number[] | null | undefined {
  if (text === 'all') return null;
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(part);
    if (!m) return undefined;
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : a;
    if (a < 1 || b > 4094 || b < a || b - a > 4094) return undefined;
    for (let v = a; v <= b; v++) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

/** Validate a single token for a parameter kind. Returns the parsed Arg or null. */
export function validateParam(kind: ParamKind, tok: string): Arg | null {
  switch (kind) {
    case 'ip': {
      const ip = parseIp(tok);
      return ip === null ? null : { ip, text: tok };
    }
    case 'mask': {
      const prefix = parseMask(tok);
      return prefix === null ? null : { prefix, text: tok };
    }
    case 'num': {
      if (!/^\d{1,5}$/.test(tok)) return null;
      const num = Number(tok);
      return num <= 65535 ? { num, text: tok } : null;
    }
    case 'vlan': {
      if (!/^\d{1,4}$/.test(tok)) return null;
      const num = Number(tok);
      return num >= 1 && num <= 4094 ? { num, text: tok } : null;
    }
    case 'word':
      return /^[A-Za-z0-9._-]{1,32}$/.test(tok) ? { text: tok } : null;
    case 'iface':
      return /^[A-Za-z0-9./-]{1,20}$/.test(tok) ? { text: tok } : null;
    case 'vlanlist': {
      const list = parseVlanList(tok.toLowerCase());
      return list === undefined ? null : { text: tok, list };
    }
    case 'target': {
      const ip = parseIp(tok);
      if (ip !== null) return { ip, text: tok };
      return normalizeHostname(tok) ? { text: tok.toLowerCase() } : null;
    }
    case 'rest':
      return { text: tok };
  }
}

export function tokenize(line: string): string[] {
  return line
    .slice(0, MAX_LINE)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.slice(0, MAX_TOKEN));
}

export interface Candidate<T> {
  def: T;
  elements: Element[];
}

export type MatchResult<T> =
  | { ok: true; def: T; args: Args }
  | { ok: false; error: string; position?: number };

/**
 * Match tokens against candidate commands. Literal words match by unique prefix;
 * an exact literal match wins over a prefix match.
 */
export function match<T>(cands: Candidate<T>[], tokens: string[]): MatchResult<T> {
  if (tokens.length === 0) return { ok: false, error: '' };
  type Live = { c: Candidate<T>; args: Args; rest: boolean };
  let live: Live[] = cands.map((c) => ({ c, args: {}, rest: false }));

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const low = tok.toLowerCase();
    const next: (Live & { exact: boolean; lit: string | null })[] = [];
    for (const l of live) {
      if (l.rest) {
        next.push({ ...l, exact: true, lit: null });
        continue;
      }
      const el = l.c.elements[i];
      if (!el) continue;
      if (el.type === 'lit') {
        const word = el.words.find((w) => w.toLowerCase() === low) ?? el.words.find((w) => w.toLowerCase().startsWith(low));
        if (!word) continue;
        const args = el.name ? { ...l.args, [el.name]: { text: word } } : l.args;
        next.push({ c: l.c, args, rest: false, exact: word.toLowerCase() === low, lit: word });
      } else if (el.kind === 'rest') {
        const text = tokens.slice(i).join(' ').slice(0, MAX_TOKEN);
        next.push({ c: l.c, args: { ...l.args, [el.name]: { text } }, rest: true, exact: true, lit: null });
      } else {
        const arg = validateParam(el.kind, tok);
        if (!arg) continue;
        next.push({ c: l.c, args: { ...l.args, [el.name]: arg }, rest: false, exact: true, lit: null });
      }
    }
    if (next.length === 0) return { ok: false, error: `% Invalid input detected at '${tok}'`, position: i };
    // Prefer exact literal matches; detect ambiguous abbreviations.
    const lits = new Set(next.filter((n) => n.lit !== null).map((n) => n.lit!.toLowerCase()));
    const exact = next.filter((n) => n.exact);
    if (exact.length > 0 && exact.length < next.length) live = exact;
    else if (lits.size > 1 && exact.length === 0) {
      return { ok: false, error: `% Ambiguous command: "${tok}" could be ${[...lits].join(', ')}`, position: i };
    } else live = next;
  }

  const complete = live.filter((l) => l.rest || l.c.elements.slice(tokens.length).every((e) => e.type === 'param' && e.optional));
  if (complete.length === 0) return { ok: false, error: '% Incomplete command.' };
  const best = complete[0]!;
  return { ok: true, def: best.c.def, args: best.args };
}

/** Possible next words for "?" help and tab completion. */
export function nextOptions<T>(cands: Candidate<T>[], tokens: string[], partial: string): { word: string; help: string }[] {
  const options = new Map<string, string>();
  const low = partial.toLowerCase();
  for (const c of cands) {
    // Does the command match the typed prefix tokens?
    let ok = true;
    for (let i = 0; i < tokens.length; i++) {
      const el = c.elements[i];
      if (!el) {
        ok = false;
        break;
      }
      if (el.type === 'param' && el.kind === 'rest') break;
      const tok = tokens[i]!.toLowerCase();
      if (el.type === 'lit' ? !el.words.some((w) => w.toLowerCase().startsWith(tok)) : !validateParam(el.kind, tokens[i]!)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const el = c.elements[tokens.length];
    if (!el) {
      if (!partial) options.set('<cr>', '');
      continue;
    }
    if (el.type === 'lit') {
      for (const w of el.words) if (w.toLowerCase().startsWith(low)) options.set(w, '');
    } else if (!partial || validateParam(el.kind, partial)) {
      options.set(`<${el.name}>`, PARAM_HINT[el.kind]);
    }
  }
  return [...options].map(([word, help]) => ({ word, help })).sort((a, b) => a.word.localeCompare(b.word));
}
