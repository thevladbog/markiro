import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createProductLabelWork } from "../src/lib/use-product-label-work.js";
import { openProductLabelWork } from "./support/product-label-work.js";
import {
  createCredentialGeneration,
  sealCredentialGeneration,
} from "../src/lib/credential-recovery.js";
const resources: Awaited<ReturnType<typeof openProductLabelWork>>[] = [];
async function setup(verification: "none" | "required" = "required") {
  const h = await openProductLabelWork(verification);
  resources.push(h);
  const generation = createCredentialGeneration("test-label-key");
  const work = createProductLabelWork({
    exec: h.exec,
    shiftId: h.input.shiftId,
    credentialOwnership: h.input.credentialOwnership,
    generation,
    getPrinting: () => h.deps,
    prepare: async () => h.input,
  });
  await work.open();
  return { h, work, generation };
}
afterEach(() => {
  for (const h of resources.splice(0)) h.close();
});
describe("product label floor controller", () => {
  it("serializes a skip with scanning and unlocks only after the durable commit", async () => {
    const { h, work, generation } = await setup();
    await work.resumePrepared();
    const job = work.getSnapshot().job;
    if (!job) throw new Error("missing job");
    expect(await work.skip(job.jobId, "stale-attempt")).toBe(false);
    work.setVerificationPaused(true);
    expect(await work.skip(job.jobId, job.attemptId)).toBe(false);
    work.setVerificationPaused(false);
    let release!: () => void;
    const run = h.exec.run;
    h.exec.run = async (sql, params) => {
      if (
        sql.includes("INSERT INTO product_label_event_commands") &&
        String(params?.[7]).includes('"kind":"verification_skipped"')
      )
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      await run(sql, params);
    };
    const skipping = work.skip(job.jobId, job.attemptId);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    expect(work.canAccept()).toBe(false);
    expect(await work.verify(h.input.raw)).toBe("stale");
    expect(await work.skip(job.jobId, job.attemptId)).toBe(false);
    release();
    expect(await skipping).toBe(true);
    expect(work.canAccept()).toBe(true);
    expect(work.getSnapshot().job?.verificationOutcome).toBe("skipped");
    await sealCredentialGeneration(generation);
    expect(await work.skip(job.jobId, job.attemptId)).toBe(false);
  });
  it("restores a prepared label without automatically printing and blocks new units", async () => {
    const { h, work } = await setup();
    expect(h.print).not.toHaveBeenCalled();
    expect(work.getSnapshot().job?.status).toBe("prepared");
    expect(work.canAccept()).toBe(false);
    await work.resumePrepared();
    expect(h.print).toHaveBeenCalledTimes(1);
    expect(work.getSnapshot().job?.status).toBe("awaiting_verification");
    expect(await work.verify(h.input.raw.replace("tail", "TAIL"))).toBe("mismatch");
    expect(work.canAccept()).toBe(false);
    expect(await work.verify(h.input.raw)).toBe("match");
    expect(work.canAccept()).toBe(true);
    expect(
      (await h.exec.all<{ count: number }>("SELECT count(*) AS count FROM codes_mirror"))[0]?.count,
    ).toBe(1);
  });
  it("keeps none distinct from verified and only releases intake after the sent commit", async () => {
    const { h, work } = await setup("none");
    let release!: () => void;
    h.print.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const sending = work.resumePrepared();
    await waitFor(() => expect(h.print).toHaveBeenCalledTimes(1));
    expect(work.canAccept()).toBe(false);
    expect(await work.verify(h.input.raw)).toBe("stale");
    release();
    await sending;
    expect(work.canAccept()).toBe(true);
    expect(work.getSnapshot().job?.verificationOutcome).toBe("not_required");
  });
  it("holds verification commit and drops another callback until it is durable", async () => {
    const { h, work } = await setup();
    await work.resumePrepared();
    let release!: () => void;
    const run = h.exec.run;
    h.exec.run = async (sql, params) => {
      if (
        sql.includes("INSERT INTO product_label_event_commands") &&
        String(params?.[7]).includes('"kind":"verified"')
      )
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      await run(sql, params);
    };
    const verifying = work.verify(h.input.raw);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    expect(work.canAccept()).toBe(false);
    expect(await work.verify(h.input.raw)).toBe("stale");
    release();
    await verifying;
    expect(work.canAccept()).toBe(true);
  });
  it("waits in-flight transport while sealing and never admits a late action", async () => {
    const { h, work, generation } = await setup();
    let release!: () => void;
    h.print.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const sending = work.resumePrepared();
    await waitFor(() => expect(h.print).toHaveBeenCalledTimes(1));
    let sealed = false;
    const sealing = sealCredentialGeneration(generation).then(() => {
      sealed = true;
    });
    await Promise.resolve();
    expect(sealed).toBe(false);
    expect(await work.verify(h.input.raw)).toBe("stale");
    release();
    await sending;
    await sealing;
    expect(work.canAccept()).toBe(false);
    await expect(work.reprint(h.input.jobId, "lost")).rejects.toThrow();
    expect(h.print).toHaveBeenCalledTimes(1);
  });
  it("restores uncertain transport without resend, accepts a full recovery scan in none", async () => {
    const { h, work } = await setup("none");
    h.print.mockRejectedValueOnce(new Error("wire"));
    await work.resumePrepared();
    expect(work.getSnapshot().job?.status).toBe("attention");
    expect(work.canAccept()).toBe(false);
    await work.close();
    const restored = createProductLabelWork({
      exec: h.exec,
      shiftId: h.input.shiftId,
      credentialOwnership: h.input.credentialOwnership,
      getPrinting: () => h.deps,
      prepare: async () => h.input,
    });
    await restored.open();
    expect(h.print).toHaveBeenCalledTimes(1);
    expect(await restored.verify(h.input.raw)).toBe("match");
    expect(restored.canAccept()).toBe(true);
  });
});
