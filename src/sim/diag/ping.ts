/**
 * ping and traceroute, built purely on simulated ICMP.
 */
import type { L3Node } from '../devices/l3';
import type { DropReason } from '../events';
import { DROP_REASON_TEXT } from '../events';
import { formatIp, type Ip } from '../net/addr';
import type { IpPacket } from '../net/pdu';

export type ProbeKind = 'reply' | 'timeout' | 'unreachable' | 'ttl-exceeded' | 'local-failure';

export interface ProbeResult {
  seq: number;
  kind: ProbeKind;
  from?: Ip;
  rttMs?: number;
  ttl?: number;
  reason?: string;
}

export interface ProbeSession {
  readonly dst: Ip;
  readonly results: ProbeResult[];
  done: boolean;
  /** Called whenever a result is added or the session completes. */
  onUpdate?: (s: ProbeSession) => void;
  cancel(): void;
}

let nextEchoId = 1;

interface Outstanding {
  seq: number;
  packetId: number;
  sentAt: number;
  ttl: number;
  resolve: (r: ProbeResult) => void;
}

/** Low-level: send one echo and resolve with the first matching outcome. */
function probe(node: L3Node, dst: Ip, echoId: number, seq: number, ttl: number, timeoutMs: number, onResult: (r: ProbeResult) => void): () => void {
  const engine = node.network.engine;
  let settled = false;
  let out: Outstanding | null = null;
  const finish = (r: ProbeResult) => {
    if (settled) return;
    settled = true;
    offIcmp();
    offFail();
    onResult(r);
  };
  const offIcmp = node.onIcmp((packet: IpPacket) => {
    if (!out) return;
    const l4 = packet.l4;
    if (l4.proto !== 'icmp') return;
    if (l4.type === 'echo-reply' && l4.id === echoId && l4.seq === seq) {
      finish({ seq, kind: 'reply', from: packet.src, rttMs: engine.now - out.sentAt, ttl: packet.ttl });
    } else if ((l4.type === 'dest-unreachable' || l4.type === 'time-exceeded') && l4.original?.id === out.packetId) {
      finish({
        seq,
        kind: l4.type === 'time-exceeded' ? 'ttl-exceeded' : 'unreachable',
        from: packet.src,
        rttMs: engine.now - out.sentAt,
        ...(l4.reason ? { reason: l4.reason } : {}),
      });
    }
  });
  const offFail = node.onLocalFailure((packet: IpPacket, reason: DropReason) => {
    if (out && packet.id === out.packetId) finish({ seq, kind: 'local-failure', reason: DROP_REASON_TEXT[reason] });
  });
  const packet = node.sendPacket(dst, { proto: 'icmp', type: 'echo-request', id: echoId, seq }, { ttl });
  out = { seq, packetId: packet.id, sentAt: engine.now, ttl, resolve: finish };
  engine.schedule(timeoutMs, () => finish({ seq, kind: 'timeout' }), 'ping-timeout');
  return () => finish({ seq, kind: 'timeout' });
}

export interface PingOptions {
  count?: number;
  intervalMs?: number;
  timeoutMs?: number;
  ttl?: number;
}

export function ping(node: L3Node, dst: Ip, opts: PingOptions = {}): ProbeSession {
  const { count = 4, intervalMs = 1000, timeoutMs = 10_000, ttl = 64 } = opts;
  const engine = node.network.engine;
  const echoId = nextEchoId++;
  const cancels: (() => void)[] = [];
  let resolved = 0;
  let cancelled = false;
  const session: ProbeSession = {
    dst,
    results: [],
    done: false,
    cancel() {
      cancelled = true;
      for (const c of cancels) c();
      session.done = true;
    },
  };
  for (let seq = 1; seq <= count; seq++) {
    engine.schedule(
      (seq - 1) * intervalMs,
      () => {
        if (cancelled) return;
        cancels.push(
          probe(node, dst, echoId, seq, ttl, timeoutMs, (r) => {
            session.results.push(r);
            session.results.sort((a, b) => a.seq - b.seq);
            resolved++;
            if (resolved === count) session.done = true;
            session.onUpdate?.(session);
          }),
        );
      },
      'ping-send',
    );
  }
  return session;
}

export function traceroute(node: L3Node, dst: Ip, opts: { maxHops?: number; timeoutMs?: number } = {}): ProbeSession {
  const { maxHops = 16, timeoutMs = 10_000 } = opts;
  const echoId = nextEchoId++;
  let cancelled = false;
  let cancelCurrent: (() => void) | null = null;
  const session: ProbeSession = {
    dst,
    results: [],
    done: false,
    cancel() {
      cancelled = true;
      cancelCurrent?.();
      session.done = true;
    },
  };
  const hop = (ttl: number) => {
    if (cancelled) return;
    cancelCurrent = probe(node, dst, echoId, ttl, ttl, timeoutMs, (r) => {
      session.results.push(r);
      const finished = r.kind === 'reply' || r.kind === 'unreachable' || r.kind === 'local-failure' || ttl >= maxHops;
      if (finished) session.done = true;
      session.onUpdate?.(session);
      if (!finished && !cancelled) hop(ttl + 1);
    });
  };
  hop(1);
  return session;
}

/** Human-readable summary lines, used by the CLI and the ping tool. */
export function formatProbe(r: ProbeResult, mode: 'ping' | 'trace'): string {
  const from = r.from !== undefined ? formatIp(r.from) : '*';
  const rtt = r.rttMs !== undefined ? `${Math.round(r.rttMs)}ms` : '';
  if (mode === 'trace') {
    if (r.kind === 'timeout') return `${String(r.seq).padStart(2)}  *  request timed out`;
    if (r.kind === 'local-failure') return `${String(r.seq).padStart(2)}  !  ${r.reason ?? 'failed'}`;
    const tag = r.kind === 'unreachable' ? `  !${r.reason ?? 'unreachable'}` : '';
    return `${String(r.seq).padStart(2)}  ${from}  ${rtt}${tag}`;
  }
  switch (r.kind) {
    case 'reply':
      return `Reply from ${from}: seq=${r.seq} ttl=${r.ttl} time=${rtt}`;
    case 'timeout':
      return `Request timed out (seq=${r.seq})`;
    case 'ttl-exceeded':
      return `From ${from}: TTL expired in transit (seq=${r.seq})`;
    case 'unreachable':
      return `From ${from}: ${r.reason ?? 'Destination unreachable'} (seq=${r.seq})`;
    case 'local-failure':
      return `Failed: ${r.reason ?? 'could not send'} (seq=${r.seq})`;
  }
}
