import type { Response } from "supertest";
import type { SsccCounterStateDto } from "../../src/modules/sscc/dto";

/**
 * Pulls one extension digit's state out of the list-shaped
 * `GET /org/profile/sscc` / `GET /counterparties/:id/sscc` response (Task 11:
 * `{ counters: SsccCounterStateDto[] }`, keyed by `extensionDigit` rather
 * than two named fields -- see `SsccCounterListDto` in
 * `src/modules/sscc/dto.ts`).
 *
 * Throws rather than returning `undefined` when the digit is missing: every
 * response from this endpoint always carries an entry for both
 * `BOX_EXTENSION_DIGIT` and `PALLET_EXTENSION_DIGIT` (see
 * `OrgProfileService.getSscc` / `CounterpartiesService.getSscc`), so an
 * absent one is a test bug -- a wrong path or a broken response -- not a
 * legitimate "not seeded yet" state, which is instead represented by that
 * digit's own default `nextSerial`.
 */
export function findCounter(res: Response, extensionDigit: number): SsccCounterStateDto {
  const counters = (res.body as { counters?: SsccCounterStateDto[] }).counters;
  const found = counters?.find((counter) => counter.extensionDigit === extensionDigit);
  if (!found) {
    throw new Error(
      `Response is missing a counter for extension digit ${extensionDigit}: ${JSON.stringify(res.body)}`,
    );
  }
  return found;
}
