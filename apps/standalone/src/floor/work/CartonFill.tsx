/** Fixed oblique projection. Moving all four vertices up by the same amount
 * keeps the level continuous across the top and both visible sides. */
export function CartonFill({ fraction }: { fraction: number }) {
  const rise = 69 * fraction;
  return (
    <svg
      className="work-carton"
      viewBox="8 5 240 181"
      aria-hidden="true"
      focusable="false"
      stroke="var(--carton-edge)"
      strokeWidth="1.4"
      strokeLinejoin="round"
    >
      <path fill="var(--carton-flap)" d="m91 20 134 45 9-9-2-4L106 10l-7 1Z" />
      <path fill="var(--carton-board)" d="m29 63 58-43-12-7-5-1-55 41 2 3Z" />
      <path fill="var(--carton-floor)" d="m89 88 139 47-61 45-139-47Z" />
      <path fill="var(--carton-inside)" d="M89 19 228 66v69L89 88Z" />
      <path fill="var(--carton-floor)" d="M28 64 89 19v69l-61 45Z" />
      {fraction > 0 && (
        <g stroke="var(--carton-level)">
          <path
            className="work-carton__surface"
            transform={`translate(0 ${-rise})`}
            fill={`color-mix(in srgb, var(--carton-top) ${Math.min(100, 32 + 136 * fraction)}%, var(--carton-floor))`}
            d="m89 88 139 47-61 45-139-47Z"
          />
          <path fill="var(--carton-side)" d={`M167 180 228 135v${-rise}l-61 45Z`} />
          <path fill="var(--carton-front)" d={`M28 133l139 47v${-rise}l-139-47Z`} />
        </g>
      )}
      <path fill="none" d="M28 64v69l139 47 61-45V66m-61 45v69" />
      <path fill="var(--carton-flap)" d="m165 110-134-46-9 4 2 2 126 43h7Z" />
      <path fill="var(--carton-board)" d="m227 67-58 43 12 1 5-1 55-40-2-2Z" />
    </svg>
  );
}
