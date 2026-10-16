/**
 * The sign-in's pictures, drawn inline in the theme's own colours (`currentColor`, tokens): the
 * badge to present, the plug of a scanner that does not answer, the tick of an accepted scan.
 * Decorative: the words beside each one say the same.
 */
const COMMON = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 3,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
} as const;

/** The badge card with its holder; the sweep line passes over it once when the screen opens. */
export function BadgeIcon() {
  return (
    <svg data-testid="badge-icon" className="sign-in-icon" viewBox="0 0 96 120" {...COMMON}>
      <rect x="6" y="6" width="84" height="108" rx="10" />
      <path d="M36 20h24" />
      <circle cx="48" cy="52" r="14" />
      <path d="M22 96c4-14 14-22 26-22s22 8 26 22" />
    </svg>
  );
}

export function PlugIcon() {
  return (
    <svg data-testid="plug-icon" className="sign-in-icon" viewBox="0 0 120 120" {...COMMON}>
      <path d="M50 38l32 32m-24 8l-16 16m52-52l14-14M44 62l-8 8a14 14 0 0 0 20 20l8-8M68 38l8-8a14 14 0 0 1 20 20l-8 8" />
      <path d="M24 96l16-16" />
    </svg>
  );
}

/** An accepted scan: a tick in a ring of the `ok` colour, with nothing that flashes. */
export function AcceptedIcon() {
  return (
    <svg data-testid="accepted-icon" className="sign-in-icon" viewBox="0 0 120 120" {...COMMON}>
      <circle cx="60" cy="60" r="52" />
      <path d="M36 62l16 16 32-34" />
    </svg>
  );
}
