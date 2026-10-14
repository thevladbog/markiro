import type { HostApi } from "../../host/api.js";
import type { DisaggregationDocument } from "../../host/disaggregation.js";

/**
 * A draft was made but the SSCC did not go in: the error names the draft, so
 * the office can offer to open it and add the line by hand.
 */
export class PackDraftWithoutLine extends Error {
  constructor(
    readonly document: DisaggregationDocument,
    override readonly cause: unknown,
  ) {
    super("the disaggregation draft was created without its line");
    this.name = "PackDraftWithoutLine";
  }
}

/**
 * «Расформировать» on a box's or a pallet's card (plan КРТ, task 9): an
 * empty draft with no reason (a reason is asked of an applied document
 * only), then its one line for the bare 18-digit `sscc`. The host checks
 * what the line names and whether it can be taken apart (`shift_open`,
 * `already_disassembled`); the page of the document, `/disaggregation/<id>`,
 * shows the line checked and asks for the reason. The same as the cloud's
 * `startDisassembly`, which passes the SSCC to the document's page instead.
 */
export async function startPackDisassembly(
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
    throw new PackDraftWithoutLine(created.document, error);
  }
  return created.document;
}
