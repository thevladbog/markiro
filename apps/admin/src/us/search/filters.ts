import { parseScannedSscc } from "@markiro/domain";
import type { usTraceSearchQuerySchema } from "@markiro/platform-contracts";
import type { z } from "zod";

export type SearchFilters = Omit<z.input<typeof usTraceSearchQuerySchema>, "cursor" | "limit">;
export type SearchState = {
  draft: SearchFilters;
  applied: SearchFilters | null;
  cursors: readonly (string | null)[];
  pageIndex: number;
  focusLotId: string | null;
};
export const emptySearchState: SearchState = {
  draft: {},
  applied: null,
  cursors: [null],
  pageIndex: 0,
  focusLotId: null,
};
export function normalizeExactLookup(value: string): string {
  const input = value.trim();
  return parseScannedSscc(input) ?? input;
}
