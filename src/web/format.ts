// Formatting. Times are shown in the browser's time zone; Pingwarden sends milliseconds.

const dtf = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const dtfSeconds = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const timeOnly = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayOnly = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

const valid = (ms: number | null | undefined): ms is number => typeof ms === 'number' && Number.isFinite(ms);

export const dateTime = (ms: number | null | undefined) => (valid(ms) ? dtf.format(ms) : '–');
export const dateTimeSeconds = (ms: number | null | undefined) => (valid(ms) ? dtfSeconds.format(ms) : '–');
export const shortTime = (ms: number) => timeOnly.format(ms);
export const shortDay = (ms: number) => dayOnly.format(ms);

/** "4 min", "2 h 5 min", "3 d 4 h": a span of time, two units at most. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!valid(ms)) return '–';
  const diff = now - ms;
  if (diff < -5000) return `in ${duration(-diff)}`;
  if (diff < 10_000) return 'just now';
  return `${duration(diff)} ago`;
}

/** "48 ms", "1.2 s", "0.31 ms". */
export function latency(ms: number | null | undefined): string {
  if (!valid(ms)) return '–';
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
  if (ms >= 10) return `${Math.round(ms)} ms`;
  return `${ms.toFixed(ms >= 1 ? 1 : 2)} ms`;
}

/** Uptime percentages keep detail where it matters: 99.95 %, not 100 %. */
export function percent(p: number | null | undefined): string {
  if (!valid(p)) return '–';
  if (p >= 100) return '100 %';
  if (p >= 99) return `${(Math.floor(p * 100) / 100).toFixed(2)} %`;
  return `${(Math.floor(p * 10) / 10).toFixed(1)} %`;
}

export const num = (n: number) => n.toLocaleString('en');

export const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/** "every 30 s", "every 6 h". */
export const interval = (seconds: number) => `every ${duration(seconds * 1000)}`;
