export interface MarkiroLogoProps {
  compact?: boolean;
  className?: string;
}

/** Bundled service identity: no network, font or tenant asset is needed. */
export function MarkiroLogo({ compact = false, className }: MarkiroLogoProps): React.JSX.Element {
  return (
    <svg
      className={["markiro-logo", compact && "markiro-logo--compact", className]
        .filter(Boolean)
        .join(" ")}
      viewBox={compact ? "0 0 64 64" : "0 0 280 64"}
      role="img"
      aria-label="Маркиро"
    >
      <rect x="4" y="4" width="56" height="56" className="markiro-logo__tile" />
      <g className="markiro-logo__pixels">
        <rect x="14" y="14" width="8" height="8" />
        <rect x="14" y="26" width="8" height="8" />
        <rect x="14" y="38" width="8" height="8" />
        <rect x="26" y="22" width="8" height="8" />
        <rect x="38" y="14" width="8" height="8" />
        <rect x="38" y="26" width="8" height="8" />
        <rect x="38" y="38" width="8" height="8" />
        <rect x="26" y="42" width="8" height="8" className="markiro-logo__signal" />
      </g>
      {compact ? null : (
        <text x="76" y="45" className="markiro-logo__wordmark">
          маркиро
        </text>
      )}
    </svg>
  );
}
