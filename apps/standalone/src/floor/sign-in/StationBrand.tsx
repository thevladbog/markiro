/**
 * The cloud station's sign-in brand (`apps/station/src/ui/StationBrand.tsx`
 * with `assets/markiro-logo-on-dark.svg`), drawn inline: the floor is dark,
 * the logo is bundled (no runtime asset), and the sign-in screen holds no
 * `<img>`. Below 1100 px the word mark goes and the mark alone stays
 * (`operator-sign-in.css`).
 */
export function StationBrand({ label }: { label: string }) {
  return (
    <div className="station-brand station-brand--compact operator-login__brand">
      <svg
        className="station-brand__logo"
        viewBox="0 0 280 64"
        role="img"
        aria-label={label}
        focusable="false"
      >
        <rect x="4" y="4" width="56" height="56" fill="#FAFAF8" />
        <g fill="#17161A">
          <rect x="14" y="14" width="8" height="8" />
          <rect x="14" y="26" width="8" height="8" />
          <rect x="14" y="38" width="8" height="8" />
          <rect x="26" y="22" width="8" height="8" />
          <rect x="38" y="14" width="8" height="8" />
          <rect x="38" y="26" width="8" height="8" />
          <rect x="38" y="38" width="8" height="8" />
          <rect x="26" y="42" width="8" height="8" fill="#3DDC7A" />
        </g>
        <text
          className="station-brand__word"
          x="76"
          y="45"
          fontFamily="IBM Plex Mono, monospace"
          fontWeight="600"
          fontSize="34"
          letterSpacing="-0.5"
          fill="#FAFAF8"
          aria-hidden="true"
        >
          маркиро
        </text>
      </svg>
    </div>
  );
}
