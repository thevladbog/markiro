import React from "react";

/* Маркиро: сетка 24, штрих 2px, прямые углы, butt caps. */
export const ICONS = {
  check: ["M5 12l5 5L20 7"],
  close: ["M6 6l12 12M18 6L6 18"],
  plus: ["M12 5v14M5 12h14"],
  minus: ["M5 12h14"],
  "chevron-down": ["M6 9l6 6 6-6"],
  "chevron-up": ["M6 15l6-6 6 6"],
  "chevron-left": ["M15 6l-6 6 6 6"],
  "chevron-right": ["M9 6l6 6-6 6"],
  "arrow-right": ["M4 12h16M13 5l7 7-7 7"],
  "arrow-left": ["M20 12H4M11 5l-7 7 7 7"],
  search: ["M10.5 3a7.5 7.5 0 110 15 7.5 7.5 0 010-15zM16 16l5 5"],
  filter: ["M3 5h18M6 12h12M10 19h4"],
  download: ["M12 3v12M7 10l5 5 5-5M4 21h16"],
  upload: ["M12 15V3M7 8l5-5 5 5M4 21h16"],
  edit: ["M4 20l1-4L16 5l3 3L8 19l-4 1zM13 8l3 3"],
  trash: ["M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"],
  eye: ["M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z", "M12 9a3 3 0 110 6 3 3 0 010-6z"],
  calendar: ["M4 5h16v16H4zM4 10h16M8 3v4M16 3v4"],
  refresh: ["M21 12a9 9 0 11-3-6.7M21 3v5h-5"],
  logout: ["M9 21H4V3h5M14 16l4-4-4-4M8 12h10"],
  more: ["M4 12h2.5M10.75 12h2.5M17.5 12h2.5"],
  home: ["M4 11l8-7 8 7M6 9v12h12V9"],
  chart: ["M4 21V10M10 21V3M16 21v-8M22 21H2"],
  report: ["M6 3h9l4 4v14H6zM14 3v5h5M9 12h6M9 16h6"],
  settings: ["M12 8a4 4 0 110 8 4 4 0 010-8z", "M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"],
  users: ["M8 8a3.5 3.5 0 110 7 3.5 3.5 0 010-7z", "M2 21c0-3.5 2.5-6 6-6s6 2.5 6 6", "M16 8.5a3 3 0 010 6M17 15.4c2.8.6 5 2.8 5 5.6"],
  user: ["M12 4a4 4 0 110 8 4 4 0 010-8z", "M4 21c0-4 3.5-7 8-7s8 3 8 7"],
  scan: ["M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4M7 12h10"],
  box: ["M3 8l9-5 9 5v8l-9 5-9-5z", "M3 8l9 5 9-5M12 13v8"],
  pallet: ["M5 3h14v6H5zM5 12h14v6H5zM3 22h18"],
  unit: ["M8 8h8v8H8zM11.25 11.25h1.5v1.5h-1.5z"],
  disassemble: ["M9 9h6v6H9z", "M4 4l3 3M4 4v3M4 4h3", "M20 4l-3 3M20 4v3M20 4h-3", "M4 20l3-3M4 20v-3M4 20h3", "M20 20l-3-3M20 20v-3M20 20h-3"],
  printer: ["M6 9V3h12v6M6 15H3V9h18v6h-3M6 13h12v8H6z"],
  agent: ["M4 4h16v6H4zM4 14h16v6H4zM7 6.5v1M7 16.5v1"],
  sync: ["M4 8a8 8 0 0114-2M18 2v4h-4", "M20 16a8 8 0 01-14 2M6 22v-4h4"],
  offline: ["M2 7c6-5 14-5 20 0M5.5 11c4-3.3 9-3.3 13 0M9 15c1.8-1.5 4.2-1.5 6 0M12 18.5v1M3 3l18 18"],
  wifi: ["M2 7c6-5 14-5 20 0M5.5 11c4-3.3 9-3.3 13 0M9 15c1.8-1.5 4.2-1.5 6 0M12 18.5v1"],
  clock: ["M12 3a9 9 0 110 18 9 9 0 010-18z", "M12 7v5l3 3"],
  alert: ["M12 3l10 18H2z", "M12 10v4M12 17v1.5"],
  duplicate: ["M8 8h12v12H8z", "M16 8V4H4v12h4"],
  "error-square": ["M4 4h16v16H4z", "M9 9l6 6M15 9l-6 6"],
  "ok-square": ["M4 4h16v16H4z", "M8 12.5l3 3 5.5-6"],
  shift: ["M9 2h6v4H9z", "M5 6h14v16H5z", "M9 12h6M9 16h4"],
  camera: ["M4 7h4l2-3h4l2 3h4v13H4z", "M12 10.5a3.5 3.5 0 110 7 3.5 3.5 0 010-7z"],
  external: ["M14 4h6v6M20 4l-9 9M9 5H4v15h15v-5"],
  pause: ["M8 5v14M16 5v14"],
  play: ["M7 4l13 8-13 8z"],
};

export function Icon({ name, size = 24, color = "currentColor", strokeWidth = 2, title, style }) {
  const ds = ICONS[name] || ICONS.alert;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth={strokeWidth} strokeLinecap="butt" strokeLinejoin="miter"
      style={style} role={title ? "img" : "presentation"} aria-label={title}>
      {ds.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
