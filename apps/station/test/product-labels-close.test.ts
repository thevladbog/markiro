// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { closeShiftOffline } from "../src/lib/shift-close.js";
import { recordProductLabelAcceptance } from "../src/lib/product-labels/acceptance.js";
import {
  prepareProductLabelReprint,
  sendPreparedProductLabel,
  verifyProductLabel,
} from "../src/lib/product-labels/printing.js";
import { openProductLabelWork } from "./support/product-label-work.js";
const opened: Awaited<ReturnType<typeof openProductLabelWork>>[] = [];
async function setup(verification: "required" | "none" = "required") {
  const h = await openProductLabelWork(verification);
  opened.push(h);
  return h;
}
afterEach(() => {
  for (const h of opened.splice(0)) h.close();
});
function closeInput(h: Awaited<ReturnType<typeof setup>>) {
  return {
    shiftId: h.input.shiftId,
    deviceId: h.input.deviceId,
    operatorId: h.actor.operatorId,
    credentialOwnership: h.input.credentialOwnership,
    reasonCode: "equipment_stop",
  };
}
describe("duplicate label close boundary", () => {
  it("does not close a shift with an unresolved label, even by direct SQL", async () => {
    const h = await setup();
    await expect(closeShiftOffline(h.exec, closeInput(h))).rejects.toThrow(
      "PRODUCT_LABEL_UNRESOLVED",
    );
    expect(await h.exec.all("SELECT event_id FROM shift_close_outbox")).toEqual([]);
    await expect(
      h.exec.run(
        `INSERT INTO shift_close_outbox(event_id,shift_id,device_id,product_id,product_name,planned_qty_snapshot,actual_qty,closed_box_count,closed_at) VALUES ('close',?,'device','product','Keg',20,1,0,?)`,
        [h.input.shiftId, h.actor.now()],
      ),
    ).rejects.toThrow("PRODUCT_LABEL_UNRESOLVED");
  });
  it("requires the current credential for a printing shift", async () => {
    const h = await setup("none");
    await sendPreparedProductLabel(h.deps, h.input.jobId);
    const { shiftId, deviceId, operatorId, reasonCode } = closeInput(h);
    const missing = { shiftId, deviceId, operatorId, reasonCode };
    await expect(closeShiftOffline(h.exec, missing)).rejects.toThrow(
      "PRODUCT_LABEL_CREDENTIAL_REQUIRED",
    );
    await expect(
      closeShiftOffline(h.exec, { ...closeInput(h), credentialOwnership: "other" }),
    ).rejects.toThrow("PRODUCT_LABEL_CREDENTIAL_MISMATCH");
  });
  it("commits the close before another acceptance or a completed-job reprint can enter", async () => {
    const h = await setup("none");
    await sendPreparedProductLabel(h.deps, h.input.jobId);
    const originalRun = h.exec.run;
    h.exec.run = async (sql, args) => {
      await originalRun(sql, args);
      if (sql.trimStart().startsWith("INSERT INTO shift_close_outbox"))
        throw new Error("lost close response");
    };
    await expect(closeShiftOffline(h.exec, closeInput(h))).rejects.toThrow("lost close response");
    h.exec.run = originalRun;
    expect(
      (
        await h.exec.all<{ status: string }>("SELECT status FROM shift_mirror WHERE id=?", [
          h.input.shiftId,
        ])
      )[0]?.status,
    ).toBe("closed");
    await expect(
      prepareProductLabelReprint(h.exec, {
        ...h.actor,
        ...closeInput(h),
        jobId: h.input.jobId,
        reason: "lost",
      }),
    ).rejects.toThrow("PRODUCT_LABEL_SHIFT_CLOSED");
    await expect(
      recordProductLabelAcceptance(h.exec, { ...h.input, jobId: crypto.randomUUID() }),
    ).rejects.toThrow();
    expect((await closeShiftOffline(h.exec, closeInput(h))).actualQty).toBe(1);
  });
  it("allows facts and explicitly requested recovery of an unresolved remotely closed shift", async () => {
    const h = await setup();
    h.print.mockRejectedValueOnce(new Error("wire"));
    const job = await sendPreparedProductLabel(h.deps, h.input.jobId);
    await h.exec.run("UPDATE shift_mirror SET status='closed' WHERE id=?", [h.input.shiftId]);
    await expect(
      prepareProductLabelReprint(h.exec, {
        ...h.actor,
        ...closeInput(h),
        jobId: job.jobId,
        reason: "damaged",
      }),
    ).rejects.toThrow("PRODUCT_LABEL_SHIFT_CLOSED");
    await prepareProductLabelReprint(h.exec, {
      ...h.actor,
      ...closeInput(h),
      jobId: job.jobId,
      reason: "damaged",
      recovery: true,
    });
    const sent = await sendPreparedProductLabel({ ...h.deps, recovery: true }, job.jobId);
    expect(
      await verifyProductLabel(h.exec, {
        ...h.actor,
        credentialOwnership: h.input.credentialOwnership,
        jobId: job.jobId,
        attemptId: sent.attemptId,
        raw: h.input.raw,
      }),
    ).toBe("match");
    expect(h.print).toHaveBeenCalledTimes(2);
  });
});
