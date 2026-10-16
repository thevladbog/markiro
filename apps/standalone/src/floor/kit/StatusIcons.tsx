import type { ReactNode } from "react";

/**
 * The glyphs of the floor's header and hub (kit: outlined, a light stroke, `currentColor` — they
 * take the chip's or button's tone). Drawn here because the repository carries no icon set; every
 * one sits on a 24 px grid and is `aria-hidden`: the words beside it (or the control's name) say it.
 */
export type GlyphName =
  | "wifi-high"
  | "wifi-medium"
  | "wifi-slash"
  | "printer"
  | "barcode"
  | "plugs"
  | "upload"
  | "stock"
  | "plus"
  | "arrow-right"
  | "check"
  | "gear"
  | "clipboard"
  | "chevron-left"
  | "chevron-right"
  | "user-switch"
  | "refresh"
  | "box"
  | "layers"
  | "qr"
  | "file"
  | "inbox"
  | "search-x"
  | "keyboard"
  | "check-circle"
  | "question-circle"
  | "x-circle"
  | "warning"
  | "circle-notch"
  | "info"
  | "stop"
  | "x"
  | "arrow-left"
  | "scan-frame"
  | "search";

const PATHS: Record<GlyphName, ReactNode> = {
  "wifi-high": (
    <>
      <path d="M2.5 9.5a14 14 0 0 1 19 0" />
      <path d="M5.5 13a9.5 9.5 0 0 1 13 0" />
      <path d="M8.6 16.4a5 5 0 0 1 6.8 0" />
      <path d="M12 19.6v.1" />
    </>
  ),
  "wifi-medium": (
    <>
      <path d="M5.5 13a9.5 9.5 0 0 1 13 0" />
      <path d="M8.6 16.4a5 5 0 0 1 6.8 0" />
      <path d="M12 19.6v.1" />
    </>
  ),
  "wifi-slash": (
    <>
      <path d="M2.5 9.5a14 14 0 0 1 5-3" />
      <path d="M16.5 6.5a14 14 0 0 1 5 3" />
      <path d="M5.5 13a9.5 9.5 0 0 1 3.4-2.1" />
      <path d="M15.1 10.9a9.5 9.5 0 0 1 3.4 2.1" />
      <path d="M8.6 16.4a5 5 0 0 1 6.8 0" />
      <path d="M12 19.6v.1" />
      <path d="M4 3.5 20 20.5" />
    </>
  ),
  printer: (
    <>
      <path d="M7 8V3.5h10V8" />
      <path d="M7 17H4.5V8.5h15V17H17" />
      <path d="M7 13.5h10v7H7z" />
    </>
  ),
  barcode: (
    <>
      <path d="M3.5 7.5v-3h3" />
      <path d="M17.5 4.5h3v3" />
      <path d="M20.5 16.5v3h-3" />
      <path d="M6.5 19.5h-3v-3" />
      <path d="M8 8v8M11 8v8M14 8v8M17 8v8" />
    </>
  ),
  plugs: (
    <>
      <path d="M14 10 18.5 5.5" />
      <path d="M16.5 3.5l4 4" />
      <path d="M10 14 5.5 18.5" />
      <path d="M3.5 16.5l4 4" />
      <path d="M8.5 9.5l6 6" />
      <path d="M3 3l18 18" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15.5V4.5" />
      <path d="M7.5 9 12 4.5 16.5 9" />
      <path d="M4.5 15.5v4h15v-4" />
    </>
  ),
  stock: (
    <>
      <path d="M12 4 21 19.5H3z" />
      <path d="M12 10v4.5" />
      <path d="M12 17v.1" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  "arrow-right": <path d="M4.5 12h15M13.5 6l6 6-6 6" />,
  check: <path d="M5 12.5 9.5 17 19 7.5" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5 14 5l2.5-.5 1 2.3 2.4 1-.5 2.6L20.5 12l-1.6 1.6.5 2.6-2.4 1-1 2.3L14 19l-2 1.5L10 19l-2.5.5-1-2.3-2.4-1 .5-2.6L3.5 12l1.6-1.6-.5-2.6 2.4-1 1-2.3L10 5z" />
    </>
  ),
  clipboard: (
    <>
      <path d="M8 4.5h8v3H8z" />
      <path d="M8 6H5.5v14.5h13V6H16" />
      <path d="M9 12h6M9 16h6" />
    </>
  ),
  "chevron-left": <path d="M15 5.5 8.5 12l6.5 6.5" />,
  "chevron-right": <path d="M9 5.5l6.5 6.5L9 18.5" />,
  "user-switch": (
    <>
      <circle cx="12" cy="9.5" r="3.3" />
      <path d="M5.8 18.5c1-2.8 3.3-4.2 6.2-4.2s5.2 1.4 6.2 4.2" />
      <path d="M3.5 12.5a8.5 8.5 0 0 1 2.6-6" />
      <path d="M5.8 3.5v3.3h3.3" />
      <path d="M20.5 11.5a8.5 8.5 0 0 1-2.6 6" />
      <path d="M18.2 20.5v-3.3h-3.3" />
    </>
  ),
  box: (
    <>
      <path d="M12 3.5 20 8v8l-8 4.5L4 16V8z" />
      <path d="M4 8l8 4.5L20 8" />
      <path d="M12 12.5v8" />
    </>
  ),
  layers: (
    <>
      <path d="M12 4 21 9l-9 5-9-5z" />
      <path d="M3 13.5l9 5 9-5" />
    </>
  ),
  qr: (
    <>
      <path d="M4.5 4.5h6v6h-6z" />
      <path d="M13.5 4.5h6v6h-6z" />
      <path d="M4.5 13.5h6v6h-6z" />
      <path d="M13.5 13.5h2.5v2.5h-2.5zM18 18h1.5v1.5H18z" />
    </>
  ),
  file: (
    <>
      <path d="M6 3.5h8.5L19 8v12.5H6z" />
      <path d="M14.5 3.5V8H19" />
      <path d="M9 13h7M9 16.5h7" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.5 13.5 6 5h12l2.5 8.5v6h-17z" />
      <path d="M3.5 13.5h5l1.2 2.5h4.6l1.2-2.5h5" />
    </>
  ),
  "search-x": (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m20 20-4.9-4.9" />
      <path d="m8.2 8.2 4.6 4.6m0-4.6-4.6 4.6" />
    </>
  ),
  keyboard: (
    <>
      <path d="M3 6.5h18v11H3z" />
      <path d="M6.5 10h.1M10 10h.1M13.5 10h.1M17 10h.1M6.5 13.5h11" />
    </>
  ),
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8 12.3 2.8 2.8 5.2-5.6" />
    </>
  ),
  "question-circle": (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.6a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.8" />
      <path d="M12 16.6v.1" />
    </>
  ),
  "x-circle": (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m9 9 6 6m0-6-6 6" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4 21 19.5H3z" />
      <path d="M12 10v4.5" />
      <path d="M12 17v.1" />
    </>
  ),
  "circle-notch": <path d="M20.5 12A8.5 8.5 0 1 1 12 3.5" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <path d="M12 7.7v.1" />
    </>
  ),
  stop: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.5 9.5h5v5h-5z" />
    </>
  ),
  x: <path d="m6 6 12 12M18 6 6 18" />,
  "arrow-left": <path d="M19.5 12h-15M10.5 6l-6 6 6 6" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m20 20-4.9-4.9" />
    </>
  ),
  "scan-frame": (
    <>
      <path d="M4 8V4.5h3.5M16.5 4.5H20V8M20 16v3.5h-3.5M7.5 19.5H4V16" />
      <path d="M8.5 8.5h7v7h-7z" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 0 1-13 5" />
      <path d="M4.5 12a7.5 7.5 0 0 1 13-5" />
      <path d="M17.5 3.5V7h-3.5" />
      <path d="M6.5 20.5V17H10" />
    </>
  ),
};

export function Glyph({ name, size = 24 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      className="floor-glyph"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}
