import { describe, expect, it, vi } from "vitest";
import { receivingFinalizedRecordSchema } from "@markiro/platform-contracts";
import { createUsBrowserClient } from "../src/us/client.js";
import {
  complete,
  finalized,
  id,
  operationKey,
  path,
  record,
} from "./support/us-receiving-finalization-fixture.js";

const input = { operationKey, expectedDraftVersion: 7, expectedInputDigest: complete.inputDigest };
const transport = (value: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockImplementation(async () => Response.json(value, { status }));

describe("receiving finalization browser boundary", () => {
  it("uses an exact finalize route and correlates event, saved version and digest", async () => {
    expect(receivingFinalizedRecordSchema.safeParse(finalized).success).toBe(true);
    const send = transport(finalized);
    expect(await createUsBrowserClient(send).finalizeReceiving(id.toUpperCase(), input)).toEqual(
      finalized,
    );
    expect(send.mock.lastCall?.[0]).toBe(`${path}/${id}/finalize`);
    expect(JSON.parse(String(send.mock.lastCall?.[1]?.body))).toEqual(input);
    for (const bad of [
      { ...finalized, id: operationKey },
      { ...finalized, draftVersion: 8 },
      {
        ...finalized,
        snapshot: {
          ...finalized.snapshot,
          confirmation: { ...finalized.snapshot.confirmation, inputDigest: "b".repeat(64) },
        },
      },
    ]) {
      await expect(
        createUsBrowserClient(transport(bad)).finalizeReceiving(id, input),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
  it("rejects forged commands and identifiers before transport", async () => {
    const send = transport(finalized);
    const client = createUsBrowserClient(send);
    await expect(client.finalizeReceiving("../profile", input)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(client.finalizeReceiving(id, { ...input, actor: "forged" })).rejects.toMatchObject(
      { code: "invalid_input" },
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("reads both record variants and strictly filters mixed-status lists", async () => {
    for (const value of [record, finalized])
      expect(await createUsBrowserClient(transport(value)).getReceivingRecord(id)).toEqual(value);
    const send = transport({ items: [], limit: 50, offset: 0 });
    await createUsBrowserClient(send).listReceivingRecords({
      status: "finalized",
      search: "REC&A",
    });
    expect(
      new URL(String(send.mock.lastCall?.[0]), "http://localhost").searchParams.get("status"),
    ).toBe("finalized");
    await expect(
      createUsBrowserClient(send).listReceivingRecords({ status: "voided" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("retains only typed 409 findings and rejects unexpected response fields", async () => {
    await expect(
      createUsBrowserClient(
        transport({ code: "event_incomplete", issues: complete.issues }, 409),
      ).finalizeReceiving(id, input),
    ).rejects.toMatchObject({ code: "event_incomplete", issues: complete.issues });
    for (const value of [
      { code: "event_incomplete", issues: [{ message: "raw secret" }] },
      { code: "event_incomplete", issues: complete.issues, debug: "raw secret" },
    ]) {
      await expect(
        createUsBrowserClient(transport(value, 409)).finalizeReceiving(id, input),
      ).rejects.toMatchObject({ code: "conflict" });
    }
  });
});
