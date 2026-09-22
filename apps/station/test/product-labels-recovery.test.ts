// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareProductLabelReprint,
  sendPreparedProductLabel,
  verifyProductLabel,
} from "../src/lib/product-labels/printing.js";
import {
  readProductLabelRecoveryShift,
  restoreProductLabelWork,
} from "../src/lib/product-labels/recovery.js";
import { appendProductLabelEvent, readProductLabelJob } from "../src/lib/product-labels/store.js";
import { openProductLabelWork } from "./support/product-label-work.js";

const handles: Awaited<ReturnType<typeof openProductLabelWork>>[] = [];
afterEach(() => {
  for (const work of handles.splice(0)) work.close();
});
async function fixture(verification: "none" | "required" = "required") {
  const work = await openProductLabelWork(verification);
  handles.push(work);
  return work;
}

describe("product label recovery", () => {
  it("restores only the current owner's pending shift, including a remotely closed shift", async () => {
    const work = await fixture();
    await work.exec.run("UPDATE shift_mirror SET status='closed' WHERE id=?", [work.input.shiftId]);
    expect(await readProductLabelRecoveryShift(work.exec, work.input.credentialOwnership)).toEqual({
      id: work.input.shiftId,
      jobId: work.input.jobId,
      status: "closed",
      mode: "validation",
    });
    expect(await readProductLabelRecoveryShift(work.exec, "another-credential")).toBeNull();
    expect(work.print).not.toHaveBeenCalled();
  });

  it("cannot turn a completed active-shift job into another recovery print", async () => {
    const work = await fixture();
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    await verifyProductLabel(work.exec, {
      ...work.deps,
      jobId: work.input.jobId,
      attemptId: work.input.preparedEvent.attemptId,
      raw: work.input.raw,
    });
    const before = await work.exec.all("SELECT * FROM product_label_events");
    await expect(
      prepareProductLabelReprint(work.exec, {
        ...work.actor,
        credentialOwnership: work.input.credentialOwnership,
        shiftId: work.input.shiftId,
        jobId: work.input.jobId,
        reason: "not_printed",
        recovery: true,
      }),
    ).rejects.toThrow("PRODUCT_LABEL_RECOVERY_UNAVAILABLE");
    expect(await work.exec.all("SELECT * FROM product_label_events")).toEqual(before);
  });

  it("restores prepared work without starting transport", async () => {
    const work = await fixture();
    work.restart();
    const result = await restoreProductLabelWork(
      work.exec,
      work.input.credentialOwnership,
      work.actor,
    );
    expect(result?.status).toBe("prepared");
    expect(work.print).not.toHaveBeenCalled();
  });
  it.each(["none", "required"] as const)(
    "turns interrupted sending into delivery_unknown for verification %s",
    async (verification) => {
      const work = await fixture(verification);
      await appendProductLabelEvent(work.exec, work.input.credentialOwnership, {
        ...work.eventBase(2),
        kind: "sending",
      });
      work.restart();
      const restored = await restoreProductLabelWork(
        work.exec,
        work.input.credentialOwnership,
        work.actor,
      );
      expect(restored?.status).toBe("attention");
      expect(
        (await readProductLabelJob(work.exec, work.input.credentialOwnership, work.input.jobId))
          ?.projection.attemptState,
      ).toBe("delivery_unknown");
      await restoreProductLabelWork(work.exec, work.input.credentialOwnership, work.actor);
      expect(work.print).not.toHaveBeenCalled();
      expect(
        await verifyProductLabel(work.exec, {
          ...work.actor,
          jobId: work.input.jobId,
          attemptId: work.input.preparedEvent.attemptId,
          credentialOwnership: work.input.credentialOwnership,
          raw: work.input.raw,
        }),
      ).toBe("match");
      expect(
        await restoreProductLabelWork(work.exec, work.input.credentialOwnership, work.actor),
      ).toBeNull();
    },
  );
  it("a disabled verification completes only after the transport result was saved", async () => {
    const work = await fixture("none");
    const result = await sendPreparedProductLabel(work.deps, work.input.jobId);
    expect(result.status).toBe("completed");
    expect(result.verificationOutcome).toBe("not_required");
    work.restart();
    expect(
      await restoreProductLabelWork(work.exec, work.input.credentialOwnership, work.actor),
    ).toBeNull();
  });
  it("keeps required verification pending after a restart and isolates credential ownership", async () => {
    const work = await fixture();
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    work.restart();
    expect(
      (await restoreProductLabelWork(work.exec, work.input.credentialOwnership, work.actor))
        ?.status,
    ).toBe("awaiting_verification");
    expect(await restoreProductLabelWork(work.exec, "other-credential", work.actor)).toBeNull();
    expect(work.print).toHaveBeenCalledTimes(1);
  });
});
