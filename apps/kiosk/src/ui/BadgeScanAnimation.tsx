/** Wordless badge/scanner cue. The adjacent copy owns the accessible instruction. */
export function BadgeScanAnimation(): React.JSX.Element {
  return (
    <div className="badge-scan-animation" aria-hidden="true">
      <div className="badge-scan-animation__reader">
        <span className="badge-scan-animation__beam" />
        <svg viewBox="0 0 96 96" focusable="false">
          <rect x="19" y="13" width="58" height="70" rx="8" />
          <circle cx="48" cy="36" r="10" />
          <path d="M31 67c2-10 8-16 17-16s15 6 17 16" />
          <path d="M37 23h22" />
        </svg>
      </div>
      <span className="badge-scan-animation__base" />
    </div>
  );
}
