import { validationPrintInputSchema } from "./product-labels/contracts.js";
import { canonicalizeKm, kmHash } from "./gs1/km.js";
import {
  VALIDATION_REPROCESSING_PROTOCOL,
  validationCodeHistorySchema,
  validationOccurrenceStatusSchema,
} from "./validation-reprocessing.js";

/** Wire fixtures parsed by the actual TypeScript schemas, consumed unchanged by Kotlin. */
export function buildValidationReprocessingFixtures() {
  const shiftId = "11111111-1111-4111-8111-111111111111";
  const productId = "22222222-2222-4222-8222-222222222222";
  const sourceId = "33333333-3333-4333-8333-333333333333";
  const raw = "010460068200001321repeat\u001d93CRYPTO";
  const codeHash = kmHash(canonicalizeKm(raw));
  const scannedAt = "2026-09-12T08:00:00.000Z";
  const policies = [undefined, false, true].map((enabled) => {
    const input = {
      mode: "duplicate_dm",
      verification: "none",
      templateId: productId,
      ...(enabled === undefined ? {} : { allowPreviouslyAcceptedCodes: enabled }),
    };
    return { input, expected: validationPrintInputSchema.parse(input) };
  });
  const history = validationCodeHistorySchema.parse({
    protocol: VALIDATION_REPROCESSING_PROTOCOL,
    shiftId,
    productId,
    snapshot: "a".repeat(64),
    fetchedAt: scannedAt,
    expiresAt: "2026-09-12T09:00:00.000Z",
    nextCursor: null,
    complete: true,
    items: [
      {
        codeHash,
        kind: "original",
        shiftId: sourceId,
        shiftNumber: "SEP26-003",
        shiftStatus: "closed",
        scannedAt,
      },
    ],
  });
  const status = validationOccurrenceStatusSchema.parse({
    protocol: VALIDATION_REPROCESSING_PROTOCOL,
    occurrences: ["first_accepted", "reprocessed", "pending", "conflict"].map((outcome) => ({
      shiftId,
      codeHash,
      scannedAt,
      outcome,
    })),
  });
  const releasedReceipt = {
    shiftId,
    codeHash,
    scannedAt,
    outcome: "first_accepted",
    ownership: "released",
  };
  validationOccurrenceStatusSchema.parse({
    protocol: VALIDATION_REPROCESSING_PROTOCOL,
    occurrences: [releasedReceipt],
  });
  const invalidReleasedReceipts = ["reprocessed", "conflict", "pending"].map((outcome) => ({
    ...releasedReceipt,
    outcome,
  }));
  return { raw, codeHash, policies, history, status, releasedReceipt, invalidReleasedReceipts };
}
