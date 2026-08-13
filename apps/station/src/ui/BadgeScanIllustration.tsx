/** Offline-only, decorative instruction for presenting an operator badge. */
export function BadgeScanIllustration() {
  return (
    <svg
      data-testid="badge-scan-illustration"
      className="badge-scan-illustration"
      viewBox="0 0 240 160"
      aria-hidden="true"
      focusable="false"
    >
      <g className="badge-scan-illustration__badge">
        <rect x="18" y="58" width="126" height="82" rx="10" />
        <rect x="34" y="76" width="28" height="28" rx="4" />
      </g>
      <g className="badge-scan-illustration__barcode">
        <path d="M78 106v22m6-22v22m8-22v22m5-22v22m9-22v22m6-22v22m10-22v22" />
      </g>
      <g className="badge-scan-illustration__scanner">
        <path d="M154 32 211 20a10 10 0 0 1 12 8l5 24a10 10 0 0 1-8 12l-14 3 10 39-20 5-16-38-17 4a10 10 0 0 1-12-8l-5-25a10 10 0 0 1 8-12Z" />
      </g>
      <path className="badge-scan-illustration__beam" d="M142 65 90 83" />
    </svg>
  );
}
