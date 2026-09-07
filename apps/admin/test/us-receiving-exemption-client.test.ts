import { receivingFinalizedRecordSchema } from "@markiro/platform-contracts";
import { describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import {
  eventId,
  exemptionFinalized,
  exemptionReadiness,
  exemptionRecord,
  operationKey,
} from "./support/us-receiving-exemption-fixture.js";
import { finalized as legacyFinalized } from "./support/us-receiving-finalization-fixture.js";

const transport = (value: unknown) =>
  vi.fn<typeof fetch>().mockImplementation(async () => Response.json(value));
const command = {
  operationKey,
  expectedDraftVersion: exemptionRecord.draftVersion,
  expectedInputDigest: exemptionReadiness.inputDigest,
  reviewedExemptLines: [1, 2],
};

describe("exempt Receiving client acknowledgement", () => {
  it("correlates the exact v2 event, version, digest and reviewed line set", async () => {
    const parsed = receivingFinalizedRecordSchema.safeParse(exemptionFinalized);
    expect(parsed.success).toBe(true);
    await expect(
      createUsBrowserClient(transport(exemptionFinalized)).finalizeReceiving(eventId, command),
    ).resolves.toEqual(exemptionFinalized);

    const mismatches = [
      { ...exemptionFinalized, id: operationKey },
      { ...exemptionFinalized, draftVersion: exemptionRecord.draftVersion + 1 },
      {
        ...exemptionFinalized,
        snapshot: {
          ...exemptionFinalized.snapshot,
          confirmation: {
            ...exemptionFinalized.snapshot.confirmation,
            inputDigest: "d".repeat(64),
          },
        },
      },
      {
        ...exemptionFinalized,
        snapshot: {
          ...exemptionFinalized.snapshot,
          confirmation: {
            ...exemptionFinalized.snapshot.confirmation,
            reviewedExemptLines: [1],
          },
        },
      },
    ];
    for (const response of mismatches)
      await expect(
        createUsBrowserClient(transport(response)).finalizeReceiving(eventId, command),
      ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("allows legacy v1 only when the command has no exempt reviews", async () => {
    const legacyCommand = {
      operationKey,
      expectedDraftVersion: legacyFinalized.draftVersion,
      expectedInputDigest: legacyFinalized.snapshot.confirmation.inputDigest,
    };
    await expect(
      createUsBrowserClient(transport(legacyFinalized)).finalizeReceiving(eventId, legacyCommand),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      createUsBrowserClient(transport(legacyFinalized)).finalizeReceiving(legacyFinalized.id, {
        ...legacyCommand,
        reviewedExemptLines: [1],
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      createUsBrowserClient(transport(legacyFinalized)).finalizeReceiving(
        legacyFinalized.id,
        legacyCommand,
      ),
    ).resolves.toEqual(legacyFinalized);
  });

  it("accepts only missing/null extension compatibility and rejects every material draft change", async () => {
    const input = { operationKey, draft: exemptionRecord.draft };
    const baseItem = exemptionRecord.draft.items[1]!;
    const changes = [
      { exemptReason: "A changed reason" },
      { exemptReceipt: { ...baseItem.exemptReceipt!, proposedTlc: "=OWN/Ä-CHANGED" } },
      { exemptReceipt: { ...baseItem.exemptReceipt!, tlcHandling: "preserve_existing" as const } },
      {
        exemptReceipt: {
          ...baseItem.exemptReceipt!,
          evidenceUrl: "https://supplier.example.test/other",
        },
      },
      { quantity: "10.501" },
      { source: { kind: "location" as const, locationId: operationKey } },
    ];
    for (const change of changes) {
      const response = {
        ...exemptionRecord,
        draft: {
          ...exemptionRecord.draft,
          items: [exemptionRecord.draft.items[0]!, { ...baseItem, ...change }],
        },
      };
      const client = createUsBrowserClient(transport(response));
      await expect(client.createReceivingDraft(input)).rejects.toMatchObject({
        code: "invalid_response",
      });
      await expect(
        client.saveReceivingDraft(eventId, {
          ...input,
          expectedDraftVersion: exemptionRecord.draftVersion,
        }),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }

    const ordinary = {
      ...exemptionRecord.draft.items[0]!,
      exemptSupplier: false,
      exemptReason: null,
      exemptReceipt: null,
    };
    const missing = Object.fromEntries(
      Object.entries(ordinary).filter(([key]) => key !== "exemptReceipt"),
    );
    const missingDraft = { ...exemptionRecord.draft, items: [missing] };
    const nullDraft = { ...exemptionRecord.draft, items: [ordinary] };
    await expect(
      createUsBrowserClient(
        transport({ ...exemptionRecord, draft: nullDraft }),
      ).createReceivingDraft({ operationKey, draft: missingDraft }),
    ).resolves.toMatchObject({ draft: nullDraft });
  });
});
