import { createHash } from "node:crypto";
import type { FinalizeReceivingInput } from "@markiro/platform-contracts";

export function receivingFinalizationCommandDigest(
  eventId: string,
  input: FinalizeReceivingInput,
): string {
  const base = {
    eventId,
    expectedDraftVersion: input.expectedDraftVersion,
    expectedInputDigest: input.expectedInputDigest,
  };
  const value = input.reviewedExemptLines?.length
    ? { ...base, reviewedExemptLines: input.reviewedExemptLines }
    : base;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
