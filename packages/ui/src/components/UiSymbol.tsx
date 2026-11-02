import type { ReactNode, SVGProps } from "react";

// OfficeIcon paths used by semantic controls; symbols stay bundled for offline screens.
const PATHS = {
  check: <path d="M5 12.500l4.500 4.500L19 7.500" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.500v.2" />
    </>
  ),
  warning: <path d="M12 4l9 15.5H3L12 4zM12 10v4M12 16.8v.2" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7a2 2 0 002 2h3" />
    </>
  ),
  pencil: <path d="M4 20h4L19 9l-4-4L4 16v4zM13.500 6.500l4 4" />,
  sync: <path d="M20 12a8 8 0 00-14-5.200L4 9M4 4v5h5M4 12a8 8 0 0014 5.200L20 15M20 20v-5h-5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l4 2" />
    </>
  ),
  play: <path d="M7 4l14 8-14 8V4z" />,
  prohibit: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M6 18 18 6" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />,
} satisfies Record<string, ReactNode>;
export type UiSymbolName = keyof typeof PATHS;

export function UiSymbol({
  name,
  size = 20,
  ...props
}: Omit<SVGProps<SVGSVGElement>, "name"> & { name: UiSymbolName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {name === "close" ? (
        <g transform="translate(-6 -6) scale(1.5)" strokeWidth={4 / 3}>
          {PATHS.close}
        </g>
      ) : (
        PATHS[name]
      )}
    </svg>
  );
}
