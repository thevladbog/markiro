import type { OfficeOperator } from "../../host/protocol.js";

/**
 * Active operators before the ones turned off, each group by personnel
 * number as text, which is the host's order too: leading zeros are part of
 * the number, so «0042» comes before «042», and «100» before «99».
 */
export function activeFirstByLogin(operators: readonly OfficeOperator[]): OfficeOperator[] {
  return [...operators].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) || (a.login < b.login ? -1 : a.login > b.login ? 1 : 0),
  );
}
