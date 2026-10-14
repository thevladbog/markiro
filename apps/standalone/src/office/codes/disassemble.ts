import type { HostApi } from "../../host/api.js";
import type { DisaggregationDocument } from "../../host/disaggregation.js";

/**
 * A draft was made but the SSCC did not go in: the office names the draft to
 * open, so the user finds it and can add the line by hand.
 */
export class DraftWithoutLine extends Error {
  constructor(
    readonly document: DisaggregationDocument,
    override readonly cause: unknown,
  ) {
    super("the disaggregation draft was created without its line");
    this.name = "DraftWithoutLine";
  }
}

/**
 * «Расформировать» of a box (plan КРТ's cards, plan ДЗГ-О's conflicts page):
 * an empty draft with no reason, then its one line for the bare 18-digit
 * `sscc` (the host checks what it names and whether it can be taken apart:
 * `shift_open`, `already_disassembled`). Answers the draft's header; the page
 * of the document is `/disaggregation/<id>`. The same mechanism as the
 * cloud's `startDisassembly`.
 */
export async function startDisassembly(
  api: HostApi,
  token: string,
  sscc: string,
): Promise<DisaggregationDocument> {
  const created = await api.createDisaggregation(token, { reasonId: null, comment: null });
  try {
    await api.addDisaggregationLines(token, created.document.id, {
      lines: [{ input: sscc, sscc }],
      import: false,
    });
  } catch (error) {
    throw new DraftWithoutLine(created.document, error);
  }
  return created.document;
}
