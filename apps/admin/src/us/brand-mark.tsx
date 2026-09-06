import "./brand-mark.css";

/** Existing Markiro symbol geometry and English landing wordmark, without RU app imports. */
export function UsBrandMark({ surface }: { surface: "inverse" | "rail" }) {
  return (
    <span
      className={`us-brand-mark us-brand-mark--${surface}`}
      role="img"
      aria-label="Markiro"
      translate="no"
    >
      <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
        <rect x="4" y="4" width="56" height="56" fill="currentColor" />
        <g className="us-brand-mark__modules">
          <rect x="14" y="14" width="8" height="8" />
          <rect x="14" y="26" width="8" height="8" />
          <rect x="14" y="38" width="8" height="8" />
          <rect x="26" y="22" width="8" height="8" />
          <rect x="38" y="14" width="8" height="8" />
          <rect x="38" y="26" width="8" height="8" />
          <rect x="38" y="38" width="8" height="8" />
          <rect x="26" y="42" width="8" height="8" fill="var(--accent-module)" />
        </g>
      </svg>
      <span lang="en">MARKIRO</span>
    </span>
  );
}
