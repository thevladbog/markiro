import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import {
  createReceipt,
  saveReceipt,
  finalizeReceipt,
  draft,
  liveDraft,
  liveFinalized,
} from "./support/us-receiving-command-fixture.js";
import { id, operationKey, complete } from "./support/us-receiving-finalization-fixture.js";
const transport = (value: unknown) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());
describe("Receiving coordinated live transport", () => {
  it("returns versioned command acknowledgements unchanged without silently reading or retrying", async () => {
    const create = transport(createReceipt);
    expect(
      await createUsBrowserClient(create).createReceivingDraft({ operationKey, draft }),
    ).toEqual(createReceipt);
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      await createUsBrowserClient(transport(saveReceipt)).saveReceivingDraft(id, {
        operationKey,
        draft,
        expectedDraftVersion: 7,
      }),
    ).toEqual(saveReceipt);
    expect(
      await createUsBrowserClient(transport(finalizeReceipt)).finalizeReceiving(id, {
        operationKey,
        expectedDraftVersion: 7,
        expectedInputDigest: complete.inputDigest,
      }),
    ).toEqual(finalizeReceipt);
  });
  it("reads live lifecycle and v4 readiness with exact target/version correlation", async () => {
    expect(await createUsBrowserClient(transport(liveDraft)).getReceivingRecord(id)).toEqual(
      liveDraft,
    );
    expect(await createUsBrowserClient(transport(liveFinalized)).getReceivingRecord(id)).toEqual(
      liveFinalized,
    );
    const readiness = {
      ...complete,
      ruleVersion: "receiving-readiness-v4",
      rootId: id,
      previousRevisionId: null,
      expectedLifecycleVersion: 1,
    };
    expect(
      await createUsBrowserClient(transport(readiness)).checkReceivingReadiness(id, 7),
    ).toEqual(readiness);
    await expect(
      createUsBrowserClient(transport(liveDraft)).getReceivingRecord(operationKey),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      createUsBrowserClient(transport(readiness)).checkReceivingReadiness(id, 6),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
