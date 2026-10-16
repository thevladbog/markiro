const ICON = {
  viewBox: "0 0 24 24",
  width: 24,
  height: 24,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
} as const;

/** The trash can of a row's delete button (Phosphor light, drawn here as the floor bundles no icon font). */
export function TrashIcon() {
  return (
    <svg {...ICON}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3" />
    </svg>
  );
}

/** The keyboard that marks the field the on-screen keypad types into. */
export function KeyboardIcon() {
  return (
    <svg {...ICON} className="setup-keyfield__icon">
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </svg>
  );
}

/** The unlink mark of «Отвязать станцию». */
export function UnlinkIcon() {
  return (
    <svg {...ICON}>
      <path d="M9 7l1.5-1.5a4 4 0 0 1 5.7 5.7L14.5 13M15 17l-1.5 1.5a4 4 0 0 1-5.7-5.7L9.5 11M4 4l3 3M20 20l-3-3" />
    </svg>
  );
}
