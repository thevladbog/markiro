// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  sendPreparedProductLabel,
  verifyProductLabel,
} from "../src/lib/product-labels/printing.js";
import { restoreProductLabelWork } from "../src/lib/product-labels/recovery.js";
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
