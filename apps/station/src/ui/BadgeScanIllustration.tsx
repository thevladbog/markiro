/**
 * Offline-only, decorative instruction for presenting an operator badge.
 * The sweep and the reader waves are CSS keyframes over transform/opacity
 * only, so the floor terminal keeps the cue alive without repainting layout.
 */
export function BadgeScanIllustration() {
  return (
    <svg
      data-testid="badge-scan-illustration"
      className="badge-scan-illustration"
      viewBox="0 0 240 160"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id="badge-scan-card-clip">
          <rect x="16" y="26" width="110" height="114" rx="14" />
        </clipPath>
      </defs>

      <g className="badge-scan-illustration__badge">
        <rect x="16" y="26" width="110" height="114" rx="14" />
        <path className="badge-scan-illustration__slot" d="M56 38h30" />
        <circle cx="44" cy="72" r="12" />
        <path d="M30 96c3-10 8-14 14-14s11 4 14 14" />
        <path className="badge-scan-illustration__field" d="M70 66h40M70 82h28" />
      </g>

      <g className="badge-scan-illustration__barcode">
        <path d="M28 106v18m7-18v18m9-18v18m5-18v18m10-18v18m7-18v18m10-18v18m5-18v18m9-18v18m10-18v18m7-18v18" />
      </g>

      <g className="badge-scan-illustration__scanner">
        <rect x="186" y="30" width="40" height="106" rx="16" />
        <rect
          className="badge-scan-illustration__aperture"
          x="200"
          y="54"
          width="12"
          height="58"
          rx="6"
        />
      </g>

      <g className="badge-scan-illustration__beam">
        <path className="badge-scan-illustration__wave" d="M178 62Q168 83 178 104" />
        <path className="badge-scan-illustration__wave" d="M170 50Q156 83 170 116" />
        <path className="badge-scan-illustration__wave" d="M162 38Q144 83 162 128" />
        <g clipPath="url(#badge-scan-card-clip)">
          <rect className="badge-scan-illustration__sweep" x="16" y="30" width="110" height="3" />
        </g>
      </g>
    </svg>
  );
}
