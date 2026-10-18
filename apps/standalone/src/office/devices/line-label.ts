import type { TFunction } from "i18next";

import type { OfficeLine } from "../../host/protocol.js";

/**
 * How the office names a device's line: none; its name, marked when the line
 * is archived (a station stays on its line when the line is archived); or
 * the start of its id when the host's list does not know it.
 */
export function lineLabel(
  lines: readonly OfficeLine[],
  lineId: string | null,
  t: TFunction,
): string {
  if (lineId === null) return t("office.common.none");
  const line = lines.find((each) => each.id === lineId);
  if (line === undefined) return `${lineId.slice(0, 8)}…`;
  return line.archived ? t("office.common.archivedName", { name: line.name }) : line.name;
}
