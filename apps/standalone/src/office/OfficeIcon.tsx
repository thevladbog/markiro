import type { ReactNode, SVGProps } from "react";

/**
 * The office's own line icons: 24 x 24, a 1.5 stroke, round ends, drawn in `currentColor` (the kit's
 * light line weight). Inline, so nothing is fetched. Decorative: a control that holds one carries
 * its name in text or `aria-label`.
 */
const PATHS = {
  home: <path d="M4 11l8-7 8 7M6 10v10h12V10M10 20v-6h4v6" />,
  factory: <path d="M3 20V9l6 4V9l6 4V5h3v15H3zM7 20v-3M12 20v-3" />,
  calendarCheck: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M8 3v4M16 3v4M4 10h16M9 15l2 2 4-4" />
    </>
  ),
  warning: <path d="M12 4l9 15.5H3L12 4zM12 10v4M12 16.8v.2" />,
  split: (
    <>
      <rect x="3" y="9" width="5" height="5" rx="1" />
      <rect x="16" y="4" width="5" height="5" rx="1" />
      <rect x="16" y="15" width="5" height="5" rx="1" />
      <path d="M8 11.5h4v-5h4M12 11.5v6h4" />
    </>
  ),
  badge: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <circle cx="12" cy="10" r="2.5" />
      <path d="M8 17c.8-2 2.3-3 4-3s3.200 1 4 3" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.500" />
      <path d="M16 16l4.500 4.500" />
    </>
  ),
  package: <path d="M12 3l8 4.500v9L12 21l-8-4.500v-9L12 3zM4 7.500l8 4.500 8-4.500M12 12v9" />,
  tag: (
    <>
      <path d="M3 12V4h8l10 10-8 8L3 12z" />
      <circle cx="8" cy="9" r="1.200" />
    </>
  ),
  building: <path d="M4 21V4h10v17M14 10h6v11M2 21h20M8 8h2M8 12h2M8 16h2M17 14h.01M17 18h.01" />,
  barcode: <path d="M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 8v8M10 8v8M13 8v8M16 8v8" />,
  handshake: (
    <path d="M3 12l4-4 4 1 3-2 3 3 4-1M3 12l5 6c1 1 2 .5 3-.5M11 17.500l1.500 1.500c1 1 2 .5 2.500-.5M15 14l2 2c1 1 2.500.5 3.500-1l.5-2M8 8l-1 1" />
  ),
  users: (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M3 19c.8-3.200 3-5 6-5s5.200 1.800 6 5" />
      <circle cx="17" cy="9.500" r="2.500" />
      <path d="M17 14c2.200.2 3.600 1.800 4 4" />
    </>
  ),
  database: (
    <>
      <rect x="4" y="4" width="16" height="6" rx="2" />
      <rect x="4" y="14" width="16" height="6" rx="2" />
      <path d="M8 7h.01M8 17h.01" />
    </>
  ),
  cloud: (
    <path d="M7 18a4 4 0 010-8 5.500 5.500 0 0110.500 1.500A3.300 3.300 0 0117 18M12 12v7m0 0l-2.500-2.500M12 19l2.500-2.500" />
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.500v.2" />
    </>
  ),
  wifi: (
    <path d="M3 9.500a13 13 0 0118 0M6 13a8.500 8.500 0 0112 0M9.200 16.300a4 4 0 015.600 0M12 19.500v.01" />
  ),
  wifiSlash: (
    <path d="M4 4l16 16M3 9.500a13 13 0 014-2.600M10 6a13 13 0 0111 3.500M6 13a8.500 8.500 0 013.200-2M14 11a8.500 8.500 0 014 2M9.200 16.300a4 4 0 015.600 0M12 19.500v.01" />
  ),
  sync: <path d="M20 12a8 8 0 00-14-5.200L4 9M4 4v5h5M4 12a8 8 0 0014 5.200L20 15M20 20v-5h-5" />,
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  window: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
    </>
  ),
  signOut: <path d="M10 4H5v16h5M9 12h11m0 0l-3.500-3.500M20 12l-3.500 3.500" />,
  caretDown: <path d="M6 9l6 6 6-6" />,
  caretRight: <path d="M9 6l6 6-6 6" />,
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8-8M16 7l3 3M14 9l2 2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.500" r="3.500" />
      <path d="M5 20c.8-3.600 3.400-5.500 7-5.500s6.200 1.900 7 5.500" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.600 5.600l1.400 1.400M17 17l1.400 1.400M18.400 5.600L17 7M7 17l-1.400 1.400" />
    </>
  ),
  moon: <path d="M20 14.500A8 8 0 019.500 4 8 8 0 1020 14.500z" />,
  eye: (
    <>
      <path d="M2.500 12S6 5.500 12 5.500 21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeSlash: (
    <path d="M4 4l16 16M9.800 6a8.500 8.500 0 012.200-.5c6 0 9.500 6.500 9.500 6.500a15 15 0 01-3 3.700M6.500 7.500C3.800 9.300 2.500 12 2.500 12s3.500 6.500 9.500 6.500c1.400 0 2.700-.4 3.800-.9M10 10.200a3 3 0 004 4" />
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  arrowLeft: <path d="M20 12H5m0 0l6-6m-6 6l6 6" />,
  arrowRight: <path d="M4 12h15m0 0l-6-6m6 6l-6 6" />,
  check: <path d="M5 12.500l4.500 4.500L19 7.500" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16v4zM13.500 6.500l4 4" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="2.600" />,
  archive: <path d="M3 5h18v4H3zM5 9v10h14V9M10 13h4" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  reset: <path d="M4 12a8 8 0 112.400 5.700M4 20v-5h5" />,
  caretLeft: <path d="M15 6l-6 6 6 6" />,
  caretsLeft: <path d="M12 6l-6 6 6 6M19 6l-6 6 6 6" />,
  caretsRight: <path d="M5 6l6 6-6 6M12 6l6 6-6 6" />,
  download: <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" />,
  sliders: <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M6 15v4" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  qrCode: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <path d="M14 14h2v2h-2zM18 14h2v2M14 18h2v2M18 19h2" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 018 0v3" />
    </>
  ),
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  image: (
    <>
      <rect x="3.500" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.500" />
      <path d="M4 17l5-4.500 4 3.500 3-2.500 4 3.500" />
    </>
  ),
  upload: <path d="M12 16V5m0 0L8 9m4-4l4 4M5 19h14" />,
  crop: <path d="M7 3v14h14M3 7h14v14" />,
  minus: <path d="M5 12h14" />,
  circleX: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9 9l6 6M15 9l-6 6" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type OfficeIconName = keyof typeof PATHS;

export interface OfficeIconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: OfficeIconName;
  size?: number;
}

export function OfficeIcon({ name, size = 20, ...rest }: OfficeIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="office-icon"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
