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
  | "refresh";

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
