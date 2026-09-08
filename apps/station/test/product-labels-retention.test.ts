// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { PRODUCT_LABEL_PROTOCOL, productLabelEventSchema } from "@markiro/domain";
import { purgeCompletedProductLabelJobs } from "../src/lib/product-labels/retention.js";
import {
  sendPreparedProductLabel,
  prepareProductLabelReprint,
} from "../src/lib/product-labels/printing.js";
import { ackProductLabelEvents } from "../src/lib/product-labels/sync.js";
import { openProductLabelWork } from "./support/product-label-work.js";
const handles: Awaited<ReturnType<typeof openProductLabelWork>>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
async function fixture() {
  const h = await openProductLabelWork("none");
  handles.push(h);
  await sendPreparedProductLabel(h.deps, h.input.jobId);
  return h;
}
async function acknowledge(h: Awaited<ReturnType<typeof fixture>>, quarantine = false) {
  const rows = await h.exec.all<{ event_json: string }>(
    "SELECT event_json FROM product_label_events ORDER BY sequence",
  );
  const events = rows.map((row) => productLabelEventSchema.parse(JSON.parse(row.event_json)));
  await ackProductLabelEvents(h.exec, h.input.credentialOwnership, events, {
    protocol: PRODUCT_LABEL_PROTOCOL,
    acceptedEventIds: quarantine ? [] : events.map((event) => event.eventId),
    quarantined: quarantine
      ? events.map((event) => ({ eventId: event.eventId, code: "invalid_transition" }))
      : [],
  });
  await h.exec.run("DELETE FROM outbox");
}
describe("retiring delivered local print payloads", () => {
  it("keeps active-shift copies, then deletes only the current owner's closed and delivered copies", async () => {
    const h = await fixture();
    await acknowledge(h);
    expect(await purgeCompletedProductLabelJobs(h.exec, h.input.credentialOwnership)).toBe(0);
    await h.exec.run("UPDATE shift_mirror SET status='closed'");
    expect(await purgeCompletedProductLabelJobs(h.exec, "other-owner")).toBe(0);
    expect(await purgeCompletedProductLabelJobs(h.exec, h.input.credentialOwnership)).toBe(1);
    expect(await purgeCompletedProductLabelJobs(h.exec, h.input.credentialOwnership)).toBe(0);
    for (const table of [
      "product_label_jobs",
      "product_label_attempts",
      "product_label_events",
      "product_label_event_commands",
      "product_label_receipts",
    ]) {
      expect(await h.exec.all(`SELECT * FROM ${table}`)).toEqual([]);
    }
    expect((await h.exec.all("SELECT code_hash FROM codes_mirror")).length).toBe(1);
    await expect(
      prepareProductLabelReprint(h.exec, {
        ...h.actor,
        credentialOwnership: h.input.credentialOwnership,
        shiftId: h.input.shiftId,
        jobId: h.input.jobId,
        reason: "lost",
      }),
    ).rejects.toThrow();
    expect(h.print).toHaveBeenCalledTimes(1);
  });
  it.each([
    "product_outbox",
    "scan_outbox",
    "quarantine",
    "ownership",
    "close_outbox",
    "pin",
    "missing_receipt",
    "conflict",
  ])("retains payloads while %s blocks retirement", async (block) => {
    const h = await fixture();
    if (block !== "product_outbox") await acknowledge(h, block === "quarantine");
    if (block === "scan_outbox")
      await h.exec.run(
        "INSERT INTO outbox(shift_id,terminal_id,raw,verdict,scanned_at,code_hash,gtin14,serial,operator_id) VALUES (?,?,?,'ok',?,?,?,?,?)",
        [
          h.input.shiftId,
          h.input.terminalId,
          h.input.raw,
          h.input.acceptedAt,
          h.input.codeHash,
          h.input.gtin14,
          h.input.serial,
          h.input.operatorId,
        ],
      );
    if (block === "missing_receipt")
      await h.exec.run(
        "DELETE FROM product_label_receipts WHERE event_id=(SELECT event_id FROM product_label_events LIMIT 1)",
      );
    if (block === "conflict")
      await h.exec.run(
        "INSERT INTO conflicts_mirror(code_hash,winning_scanned_at,detected_at) VALUES (?, '2026-09-08T09:00:00Z', '2026-09-08T11:00:00Z')",
        [h.input.codeHash],
      );
    if (block === "ownership")
      await h.exec.run("UPDATE product_label_jobs SET ownership_conflict=1");
    if (block === "close_outbox")
      await h.exec.run(
        "INSERT INTO shift_close_outbox(event_id,shift_id,device_id,product_id,product_name,planned_qty_snapshot,actual_qty,closed_box_count,closed_at) VALUES ('close',?,'device','product','Keg',20,1,0,?)",
        [h.input.shiftId, h.actor.now()],
      );
    if (block === "pin")
      await h.exec.run(
        "INSERT INTO station_meta(key,value) VALUES ('sync_pending_product_label_batch','pinned')",
      );
    await h.exec.run("UPDATE shift_mirror SET status='closed'");
    expect(await purgeCompletedProductLabelJobs(h.exec, h.input.credentialOwnership)).toBe(0);
    expect((await h.exec.all("SELECT job_id FROM product_label_jobs")).length).toBe(1);
  });
});
