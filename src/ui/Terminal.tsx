import { useEffect, useRef, useState } from 'preact/hooks';
import { Shell } from '../cli/shell';
import type { Device } from '../sim';

interface Session {
  shell: Shell;
  lines: { id: number; text: string; kind: 'out' | 'in' }[];
  listeners: Set<() => void>;
}

const sessions = new WeakMap<Device, Session>();
let lineId = 1;

function sessionFor(device: Device): Session {
  let s = sessions.get(device);
  if (!s) {
    const session: Session = {
      shell: null as unknown as Shell,
      lines: [],
      listeners: new Set(),
    };
    session.shell = new Shell(device, (out) => {
      for (const text of out) session.lines.push({ id: lineId++, text, kind: 'out' });
      if (session.lines.length > 500) session.lines.splice(0, session.lines.length - 500);
      for (const l of session.listeners) l();
    });
    session.lines.push({ id: lineId++, text: session.shell.banner, kind: 'out' });
    sessions.set(device, session);
    s = session;
  }
  return s;
}

export function Terminal({ device }: { device: Device }) {
  const session = sessionFor(device);
  const [, setTick] = useState(0);
  const [input, setInput] = useState('');
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [suggest, setSuggest] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    session.listeners.add(l);
    return () => session.listeners.delete(l);
  }, [session]);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  });

  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, [device]);

  const submit = () => {
    const line = input;
    session.lines.push({ id: lineId++, text: `${session.shell.prompt()} ${line}`, kind: 'in' });
    setInput('');
    setHistIdx(null);
    setSuggest([]);
    session.shell.execute(line);
    setTick((n) => n + 1);
  };

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    const hist = session.shell.history;
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const r = session.shell.complete(input);
      setInput(r.line);
      setSuggest(r.options);
    } else if (e.key === '?') {
      e.preventDefault();
      session.lines.push({ id: lineId++, text: `${session.shell.prompt()} ${input}?`, kind: 'in' });
      session.shell.execute(input + '?');
      setTick((n) => n + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (hist.length === 0) return;
      const i = histIdx === null ? hist.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(i);
      setInput(hist[i] ?? '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx === null) return;
      const i = histIdx + 1;
      if (i >= hist.length) {
        setHistIdx(null);
        setInput('');
      } else {
        setHistIdx(i);
        setInput(hist[i] ?? '');
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      session.lines = [];
      setTick((n) => n + 1);
    }
  };

  return (
    <div class="terminal" onClick={() => field.current?.focus()}>
      <div class="term-out" ref={scroller} role="log" aria-live="polite">
        {session.lines.map((l) => (
          <div key={l.id} class={l.kind === 'in' ? 'term-in' : l.text.startsWith('%') ? 'term-err' : undefined}>
            {l.text}
          </div>
        ))}
      </div>
      {suggest.length > 0 && <div class="term-suggest">{suggest.join('   ')}</div>}
      <div class="term-line">
        <span class="term-prompt">{session.shell.prompt()}</span>
        <input
          ref={field}
          class="term-input"
          value={input}
          maxLength={256}
          spellcheck={false}
          autocomplete="off"
          aria-label={`Terminal for ${device.name}`}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          onKeyDown={onKey}
        />
      </div>
    </div>
  );
}
