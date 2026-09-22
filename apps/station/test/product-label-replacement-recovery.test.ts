// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductLabelWork } from "../src/lib/use-product-label-work.js";
import { openProductLabelWork } from "./support/product-label-work.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
} from "../src/lib/credential-recovery.js";
import {
  persistReplacementEvidenceRecovery,
  RECOVERY_EVIDENCE_KEY,
} from "../src/lib/replacement-evidence-recovery.js";
import { requireReplacementLabelRecovery } from "../src/lib/product-labels/recovery.js";

const resources: Awaited<ReturnType<typeof openProductLabelWork>>[] = [];
afterEach(() => {
  for (const h of resources.splice(0)) h.close();
});
async function setup() {
  const generation = createCredentialGeneration("recovery-key");
  const owner = await credentialGenerationOwnership(generation);
  if (!owner) throw new Error("fixture owner");
  const h = await openProductLabelWork("required", owner);
  resources.push(h);
  await persistReplacementEvidenceRecovery(h.exec, {
    tenantId: "tenant",
    deviceId: h.input.deviceId,
    serverUrl: "https://station.example",
    apiKey: "recovery-key",
    deviceName: "Station",
    organizationName: "Org",
    operators: [],
    recovery: {
      version: 1,
      purpose: "replacement_evidence_recovery",
      operatorRoster: "preserve_sealed",
      executionId: crypto.randomUUID(),
      intentId: crypto.randomUUID(),
      credentialEpoch: 3,
      requestedAt: "2026-09-17T00:00:00Z",
      expiresAt: "2026-09-18T00:00:00Z",
    },
  });
  h.restart();
  return { h, owner, generation };
}
describe("replacement saved-print authority", () => {
  it("sends only the persisted bytes on explicit resume and never accepts or reprints completed work", async () => {
    const { h, owner, generation } = await setup();
    const prepare = vi.fn(async () => h.input);
    const work = createProductLabelWork({
      exec: h.exec,
      shiftId: h.input.shiftId,
      credentialOwnership: owner,
      recoveryJobId: h.input.jobId,
      generation,
      getPrinting: () => h.deps,
      prepare,
    });
    await work.open();
    expect(work.getSnapshot().job?.jobId).toBe(h.input.jobId);
    expect(work.canAccept()).toBe(false);
    expect(h.print).not.toHaveBeenCalled();
    await expect(work.accept(h.input.raw)).resolves.toEqual({ status: "busy" });
    await expect(work.reprint(crypto.randomUUID(), "lost")).rejects.toThrow(
      "PRODUCT_LABEL_RECOVERY_UNAVAILABLE",
    );
    await work.resumePrepared();
    expect(h.print).toHaveBeenCalledExactlyOnceWith(
      h.deps.target,
      new Uint8Array(Buffer.from(h.input.bytesBase64, "base64")),
    );
    await expect(work.verify(h.input.raw)).resolves.toBe("match");
    expect(work.getSnapshot().job?.status).toBe("completed");
    expect(work.canAccept()).toBe(false);
    await expect(work.accept(h.input.raw)).resolves.toEqual({ status: "busy" });
    await expect(work.reprint(h.input.jobId, "lost")).rejects.toThrow(
      "PRODUCT_LABEL_RECOVERY_UNAVAILABLE",
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(await h.exec.all("SELECT * FROM product_label_jobs")).toHaveLength(1);
    expect(h.print).toHaveBeenCalledTimes(1);
    await work.close();
  });
  it.each(["job", "shift", "owner", "device", "completed_execution", "absent_purpose"] as const)(
    "fails closed when the durable %s binding is unavailable",
    async (mismatch) => {
      const { h, owner } = await setup();
      if (mismatch === "device")
        await h.exec.run(
          "UPDATE station_meta SET value=json_set(value,'$.deviceId','other') WHERE key=?",
          [RECOVERY_EVIDENCE_KEY],
        );
      if (mismatch === "completed_execution")
        await h.exec.run(
          "UPDATE station_meta SET value=json_set(value,'$.completed',json('true')) WHERE key=?",
          [RECOVERY_EVIDENCE_KEY],
        );
      if (mismatch === "absent_purpose")
        await h.exec.run("DELETE FROM station_meta WHERE key=?", [RECOVERY_EVIDENCE_KEY]);
      await expect(
        requireReplacementLabelRecovery(
          h.exec,
          mismatch === "owner" ? "another-owner" : owner,
          mismatch === "shift" ? crypto.randomUUID() : h.input.shiftId,
          mismatch === "job" ? crypto.randomUUID() : h.input.jobId,
        ),
      ).rejects.toThrow();
      expect(h.print).not.toHaveBeenCalled();
      expect(await h.exec.all("SELECT * FROM product_label_jobs")).toHaveLength(1);
    },
  );
});
