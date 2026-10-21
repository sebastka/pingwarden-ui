// Stroke icons on a 16×16 grid; they inherit the text colour.
import type { ReactNode } from 'react';

const PATHS = {
  check: <path d="m3 8.5 3 3 7-7" />,
  down: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="m5.7 5.7 4.6 4.6M10.3 5.7l-4.6 4.6" />
    </>
  ),
  alert: (
    <>
      <path d="M8 1.8 14.8 13.8H1.2z" />
      <path d="M8 6.2v3.6M8 11.8h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.5V8l2.3 1.6" />
    </>
  ),
  wrench: (
    <path d="M10.2 1.8a3.6 3.6 0 0 0-3.3 5L2.2 11.5a1.3 1.3 0 0 0 1.9 1.9L8.8 8.7a3.6 3.6 0 0 0 5-3.3l-2.1 2.1-2.1-.5-.5-2.1z" />
  ),
  pause: <path d="M5.5 3.5v9M10.5 3.5v9" />,
  play: <path d="M4.5 2.8v10.4L13 8z" />,
  dot: <circle cx="8" cy="8" r="2.5" />,
  zap: <path d="M9 1.5 3 9h4.5L7 14.5 13 7H8.5z" />,
  refresh: <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 4 4" />
    </>
  ),
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7.2v4M8 4.8h.01" />
    </>
  ),
  bell: (
    <>
      <path d="M3.5 11.5V7a4.5 4.5 0 0 1 9 0v4.5l1 1.2h-11z" />
      <path d="M6.5 14a1.6 1.6 0 0 0 3 0" />
    </>
  ),
  send: <path d="M14.5 1.5 7 9M14.5 1.5 10 14.5 7 9 1.5 6z" />,
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />,
  grid: (
    <>
      <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
      <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    </>
  ),
  activity: <path d="M1.5 8h3l2-5 3 10 2-5h3" />,
  server: (
    <>
      <rect x="1.5" y="2" width="13" height="5" rx="1" />
      <rect x="1.5" y="9" width="13" height="5" rx="1" />
      <path d="M4 4.5h.01M4 11.5h.01" />
    </>
  ),
  logout: <path d="M6 2.5H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3M10.5 11 13.5 8l-3-3M13.5 8H6" />,
  chevronRight: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  chevronDown: <path d="m3.5 6 4.5 4.5L12.5 6" />,
  tag: (
    <>
      <path d="M1.5 2.5v5l7 7 6-6-7-7h-5a1 1 0 0 0-1 1z" />
      <circle cx="5" cy="5" r="1" />
    </>
  ),
  folder: <path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6.5a1 1 0 0 0-1-1H7.6L6 3H2.5a1 1 0 0 0-1 1.5z" />,
  link: <path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.8 2.8 0 0 1 4 4L11 8.5M9 11.5l-1.2 1.2a2.8 2.8 0 0 1-4-4L5 7.5" />,
  history: <path d="M2 8a6 6 0 1 0 1.8-4.3M2 2v3.5h3.5M8 5v3.2l2.2 1.5" />,
  lock: (
    <>
      <rect x="3" y="7" width="10" height="7.5" rx="1" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </>
  ),
  certificate: (
    <>
      <rect x="1.5" y="2.5" width="13" height="8.5" rx="1" />
      <circle cx="11" cy="11" r="2" />
      <path d="m10 12.8-.5 2 1.5-.8 1.5.8-.5-2M4 5.5h6M4 8h3.5" />
    </>
  ),
  flap: <path d="M1.5 10.5 4 5.5l2.5 5 2.5-5 2.5 5 2.5-5" />,
  maximize: <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />,
  star: <path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />,
  bookmark: <path d="M4 1.5h8v13l-4-3-4 3z" />,
  download: <path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M2 10.5v3h12v-3" />,
  bellOff: (
    <>
      <path d="M3.5 11.5V7a4.5 4.5 0 0 1 7.3-3.5M12.5 6.5v5l1 1.2H5" />
      <path d="M6.5 14a1.6 1.6 0 0 0 3 0M2 2l12 12" />
    </>
  ),
  share: (
    <>
      <circle cx="12" cy="3.5" r="1.8" />
      <circle cx="4" cy="8" r="1.8" />
      <circle cx="12" cy="12.5" r="1.8" />
      <path d="m5.6 7.1 4.8-2.7M5.6 8.9l4.8 2.7" />
    </>
  ),
  printer: (
    <>
      <path d="M4 5.5V1.5h8v4M4 11.5H2.5v-6h11v6H12" />
      <rect x="4" y="9" width="8" height="5.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`icon ${className ?? ''}`}
    >
      {PATHS[name]}
    </svg>
  );
}
