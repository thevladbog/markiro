/**
 * The product's mark for the office sign-in: the sidebar's square mark
 * (`@markiro/ui` `Sidebar`) in the theme's colours, drawn inline (nothing is
 * fetched), with the product name beside it.
 */
export function OfficeBrandMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="56" height="56" fill="var(--fg-1)" />
      <g fill="var(--surface-page)">
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
  );
}
