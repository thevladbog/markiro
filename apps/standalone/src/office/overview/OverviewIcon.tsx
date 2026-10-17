import type { SVGProps } from "react";

import { OfficeIcon, type OfficeIconName } from "../OfficeIcon.js";

/**
 * The few line icons «Обзор» needs beyond `OfficeIcon`'s set, drawn the same way (24 x 24, a 1.5
 * stroke, round ends, `currentColor`). Decorative: the control or the text beside one carries the
 * meaning.
 */
const PATHS = {
  clock: (
    <>
      <circle cx="12" cy="12" r="8.500" />
      <path d="M12 7.500V12l3 2" />
    </>
  ),
  timer: (
    <>
      <circle cx="12" cy="13.500" r="7" />
      <path d="M12 13.500V10M9.500 3h5M12 3v3.500" />
    </>
  ),
  gauge: (
    <>
      <path d="M4 17a8 8 0 1116 0" />
      <path d="M12 17l3.500-5" />
    </>
  ),
  flag: <path d="M6 21V4M6 5h11l-2 3.500 2 3.500H6" />,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />,
  scan: (
    <>
      <path d="M3 8V5a2 2 0 012-2h3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M21 16v3a2 2 0 01-2 2h-3" />
      <path d="M7 12h10" />
    </>
  ),
  layers: <path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17.500l9 5 9-5" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="8.500" />
      <path d="M8.500 12.200l2.500 2.500 4.500-5" />
    </>
  ),
  alertCircle: (
    <>
      <circle cx="12" cy="12" r="8.500" />
      <path d="M12 7.500v5M12 16v.2" />
    </>
  ),
  circle: <circle cx="12" cy="12" r="8.500" />,
  checklist: (
    <path d="M9 6h11M9 12h11M9 18h11M3.500 6l1.200 1.200L7 4.800M3.500 12l1.200 1.200L7 10.800M3.500 18l1.200 1.200L7 16.800" />
  ),
  hourglass: <path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9" />,
} as const;

export type OverviewIconName = keyof typeof PATHS;

export interface OverviewIconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: OverviewIconName;
  size?: number;
}

export function OverviewIcon({ name, size = 16, ...rest }: OverviewIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="office-icon"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}

function isOverviewIcon(name: string): name is OverviewIconName {
  return name in PATHS;
}

/** Either set's icon by name: «Обзор» draws from `OfficeIcon` and from its own few. */
export function Glyph({
  name,
  size = 16,
}: {
  name: OfficeIconName | OverviewIconName;
  size?: number;
}) {
  return isOverviewIcon(name) ? (
    <OverviewIcon name={name} size={size} />
  ) : (
    <OfficeIcon name={name} size={size} />
  );
}
