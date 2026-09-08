// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  sendPreparedProductLabel,
  verifyProductLabel,
  prepareProductLabelReprint,
} from "../src/lib/product-labels/printing.js";
import { appendProductLabelEvent, readProductLabelJob } from "../src/lib/product-labels/store.js";
import { openProductLabelWork } from "./support/product-label-work.js";
import { recordProductLabelAcceptance } from "../src/lib/product-labels/acceptance.js";
import { productLabelAcceptanceFixture } from "./support/product-labels.js";
import { restoreProductLabelWork } from "../src/lib/product-labels/recovery.js";

describe("product label printing", () => {
  let work: Awaited<ReturnType<typeof openProductLabelWork>>;
  beforeEach(async () => {
    work = await openProductLabelWork();
  });
  afterEach(() => work?.close());
  const stored = () =>
    readProductLabelJob(work.exec, work.input.credentialOwnership, work.input.jobId);
  const verify = (raw: string, attemptId = work.input.preparedEvent.attemptId) =>
    verifyProductLabel(work.exec, {
      ...work.actor,
      credentialOwnership: work.input.credentialOwnership,
      jobId: work.input.jobId,
      attemptId,
      raw,
    });

  it("persists sending before transport, then waits for required verification", async () => {
    work.print.mockImplementation(async () => {
      expect((await stored())?.projection.attemptState).toBe("sending");
    });
    const result = await sendPreparedProductLabel(work.deps, work.input.jobId);
    expect(work.print).toHaveBeenCalledExactlyOnceWith(
      work.deps.target,
      new Uint8Array(Buffer.from(work.input.bytesBase64, "base64")),
    );
    expect(result.status).toBe("awaiting_verification");
    expect(result.verificationOutcome).toBe("pending");
    expect(
      await work.exec.all("SELECT event_json FROM product_label_events ORDER BY sequence"),
    ).toHaveLength(3);
  });

  it("a double click or retry cannot send twice", async () => {
    await Promise.all([
      sendPreparedProductLabel(work.deps, work.input.jobId),
      sendPreparedProductLabel(work.deps, work.input.jobId),
    ]);
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    expect(work.print).toHaveBeenCalledTimes(1);
  });

  it("does not classify an active in-process transport as interrupted", async () => {
    work.print.mockImplementation(async () => {
      const restored = await restoreProductLabelWork(
        work.exec,
        work.input.credentialOwnership,
        work.actor,
      );
      expect(restored?.status).toBe("sending");
      expect((await stored())?.projection.latestSequence).toBe(2);
    });
    expect((await sendPreparedProductLabel(work.deps, work.input.jobId)).status).toBe(
      "awaiting_verification",
    );
  });

  it("retains physical result and verification facts if an ownership conflict arrives during transport", async () => {
    work.print.mockImplementation(async () => {
      await work.exec.run("UPDATE product_label_jobs SET ownership_conflict=1");
    });
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    expect(await verify(work.input.raw)).toBe("match");
    expect((await stored())?.projection.status).toBe("completed");
    await expect(
      prepareProductLabelReprint(work.exec, {
        ...work.actor,
        credentialOwnership: work.input.credentialOwnership,
        jobId: work.input.jobId,
        shiftId: work.input.shiftId,
        reason: "damaged",
      }),
    ).rejects.toMatchObject({ code: "PRODUCT_LABEL_OWNERSHIP_CONFLICT" });
    expect(work.print).toHaveBeenCalledTimes(1);
  });

  it("does not send after losing the acknowledgement of a committed sending claim", async () => {
    const exec = work.exec;
    const uncertain = {
      ...exec,
      run: async (...args: Parameters<typeof exec.run>) => {
        await exec.run(...args);
        if (args[0].includes("INSERT INTO product_label_event_commands"))
          throw new Error("lost claim reply");
      },
    };
    await expect(
      sendPreparedProductLabel({ ...work.deps, exec: uncertain }, work.input.jobId),
    ).rejects.toThrow("lost claim reply");
    expect((await stored())?.projection.attemptState).toBe("sending");
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    expect(work.print).not.toHaveBeenCalled();
    work.restart();
    expect(
      (await restoreProductLabelWork(work.exec, work.input.credentialOwnership, work.actor))
        ?.status,
    ).toBe("attention");
  });

  it.each([
    ["event", "BEFORE INSERT ON product_label_events"],
    ["attempt", "BEFORE UPDATE ON product_label_attempts"],
    ["projection", "BEFORE UPDATE ON product_label_jobs"],
    ["outbox", "BEFORE INSERT ON product_label_outbox"],
  ])("rolls back the whole sending transition when the %s write fails", async (_name, clause) => {
    await work.exec.run(
      `CREATE TRIGGER atomic_fault ${clause} BEGIN SELECT RAISE(ABORT,'atomic fault'); END`,
    );
    await expect(sendPreparedProductLabel(work.deps, work.input.jobId)).rejects.toThrow(
      "atomic fault",
    );
    expect(work.print).not.toHaveBeenCalled();
    expect((await stored())?.projection.latestSequence).toBe(1);
    expect(await work.exec.all("SELECT * FROM product_label_event_commands")).toHaveLength(0);
    expect(await work.exec.all("SELECT * FROM product_label_events")).toHaveLength(1);
    expect(await work.exec.all("SELECT * FROM product_label_outbox")).toHaveLength(1);
  });

  it("cannot report a successful scan when persisting verification fails", async () => {
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    await work.exec.run(
      "CREATE TRIGGER verify_fault BEFORE INSERT ON product_label_outbox BEGIN SELECT RAISE(ABORT,'verification fault'); END",
    );
    await expect(verify(work.input.raw)).rejects.toThrow("verification fault");
    expect((await stored())?.projection.status).toBe("awaiting_verification");
    expect((await stored())?.attempts[0]?.verifiedAt).toBeNull();
    expect(await work.exec.all("SELECT * FROM product_label_events")).toHaveLength(3);
  });

  it("serializes competing event claims across rotating database connections", async () => {
    const outcomes = await Promise.all([
      appendProductLabelEvent(work.exec, work.input.credentialOwnership, {
        ...work.eventBase(2),
        kind: "sending",
      }),
      appendProductLabelEvent(work.exec, work.input.credentialOwnership, {
        ...work.eventBase(2),
        kind: "sending",
      }),
    ]);
    expect(outcomes.sort()).toEqual(["applied", "stale"]);
    expect(await work.exec.all("SELECT * FROM product_label_event_commands")).toHaveLength(1);
    expect((await stored())?.projection.latestSequence).toBe(2);
  });

  it.each(["credential", "shift", "released", "conflict", "pending"])(
    "blocks reprint with an invalid %s boundary",
    async (boundary) => {
      await sendPreparedProductLabel(work.deps, work.input.jobId);
      await verify(work.input.raw);
      if (boundary === "released") await work.exec.run("DELETE FROM codes_mirror");
      if (boundary === "conflict")
        await work.exec.run("UPDATE product_label_jobs SET ownership_conflict=1");
      if (boundary === "pending")
        await recordProductLabelAcceptance(
          work.exec,
          productLabelAcceptanceFixture({ serial: "OTHER-UNIT" }),
        );
      await expect(
        prepareProductLabelReprint(work.exec, {
          ...work.actor,
          credentialOwnership:
            boundary === "credential" ? "other-credential" : work.input.credentialOwnership,
          shiftId: boundary === "shift" ? "other-shift" : work.input.shiftId,
          jobId: work.input.jobId,
          reason: "lost",
        }),
      ).rejects.toMatchObject({
        code:
          boundary === "credential"
            ? "PRODUCT_LABEL_JOB_MISSING"
            : boundary === "shift"
              ? "PRODUCT_LABEL_SHIFT_MISMATCH"
              : boundary === "pending"
                ? "PRODUCT_LABEL_BUSY"
                : "PRODUCT_LABEL_OWNERSHIP_CONFLICT",
      });
      expect((await stored())?.projection.attemptNo).toBe(1);
      expect(work.print).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["unconfigured", "language", "dpi"])(
    "records a failure before transport for %s",
    async (kind) => {
      const deps = {
        ...work.deps,
        ...(kind === "unconfigured"
          ? { target: null }
          : kind === "language"
            ? { language: "tspl" as const }
            : { dpi: 300 as const }),
      };
      const result = await sendPreparedProductLabel(deps, work.input.jobId);
      expect(result.status).toBe("attention");
      expect((await stored())?.projection.attemptState).toBe("failed_before_send");
      expect(work.print).not.toHaveBeenCalled();
    },
  );

  it("does not touch transport when the sending commit fails", async () => {
    await work.exec.run(
      "CREATE TRIGGER fail_claim BEFORE INSERT ON product_label_events WHEN json_extract(NEW.event_json,'$.kind')='sending' BEGIN SELECT RAISE(ABORT,'claim fault'); END",
    );
    await expect(sendPreparedProductLabel(work.deps, work.input.jobId)).rejects.toThrow(
      "claim fault",
    );
    expect(work.print).not.toHaveBeenCalled();
    expect((await stored())?.projection.status).toBe("prepared");
  });

  it("keeps an uncertain transport result visible", async () => {
    work.print.mockRejectedValue(new Error("printer disconnected"));
    const result = await sendPreparedProductLabel(work.deps, work.input.jobId);
    expect(result.status).toBe("attention");
    expect((await stored())?.projection.attemptState).toBe("delivery_unknown");
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    expect(work.print).toHaveBeenCalledTimes(1);
  });

  it("leaves durable sending when recording the successful transport result fails", async () => {
    await work.exec.run(
      "CREATE TRIGGER fail_sent BEFORE INSERT ON product_label_events WHEN json_extract(NEW.event_json,'$.kind')='sent' BEGIN SELECT RAISE(ABORT,'sent fault'); END",
    );
    await expect(sendPreparedProductLabel(work.deps, work.input.jobId)).rejects.toThrow(
      "sent fault",
    );
    expect((await stored())?.projection.attemptState).toBe("sending");
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    expect(work.print).toHaveBeenCalledTimes(1);
  });

  it("compares the full payload including crypto tail without accepting additional units", async () => {
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    expect(await verify("garbage")).toBe("invalid");
    expect(await verify(work.input.raw.replace("tail", "fail"))).toBe("mismatch");
    expect((await stored())?.projection.status).toBe("awaiting_verification");
    expect(await verify(work.input.raw)).toBe("match");
    expect((await stored())?.projection.verificationOutcome).toBe("verified");
    for (const table of ["codes_mirror", "scan_events_mirror", "outbox"])
      expect(await work.exec.all(`SELECT * FROM ${table}`)).toHaveLength(1);
  });

  it("a repeated verification callback cannot confirm twice", async () => {
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    expect((await Promise.all([verify(work.input.raw), verify(work.input.raw)])).sort()).toEqual([
      "match",
      "stale",
    ]);
    expect(await verify(work.input.raw)).toBe("stale");
  });

  it("reprints only the saved bytes and preserves prior verification attribution", async () => {
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    await verify(work.input.raw);
    const nextActor = { ...work.actor, operatorId: "b0000000-0000-4000-8000-000000000001" };
    const attemptId = await prepareProductLabelReprint(work.exec, {
      ...nextActor,
      credentialOwnership: work.input.credentialOwnership,
      jobId: work.input.jobId,
      shiftId: work.input.shiftId,
      reason: "damaged",
    });
    expect(attemptId).not.toBe(work.input.preparedEvent.attemptId);
    expect(await verify(work.input.raw)).toBe("stale");
    await sendPreparedProductLabel({ ...work.deps, ...nextActor }, work.input.jobId);
    expect(work.print.mock.calls[1]).toEqual(work.print.mock.calls[0]);
    const result = await stored();
    expect(result?.fields).toEqual(work.input.fields);
    expect(result?.attempts[0]?.verifiedBy).toBe(work.input.operatorId);
    expect(result?.attempts[1]?.prepared).toMatchObject({
      attemptNo: 2,
      reason: "damaged",
      operatorId: nextActor.operatorId,
    });
    expect(result?.projection.verificationOutcome).toBe("pending");
    expect(
      await verifyProductLabel(work.exec, {
        ...nextActor,
        credentialOwnership: work.input.credentialOwnership,
        jobId: work.input.jobId,
        attemptId,
        raw: work.input.raw,
      }),
    ).toBe("match");
    expect((await stored())?.attempts[1]?.verifiedBy).toBe(nextActor.operatorId);
    expect(await work.exec.all("SELECT * FROM codes_mirror")).toHaveLength(1);
  });

  it("replays an identical event but rejects reuse with different content and ignores stale sequences", async () => {
    const sending = { ...work.eventBase(2), kind: "sending" as const };
    expect(await appendProductLabelEvent(work.exec, work.input.credentialOwnership, sending)).toBe(
      "applied",
    );
    expect(await appendProductLabelEvent(work.exec, work.input.credentialOwnership, sending)).toBe(
      "replayed",
    );
    await expect(
      appendProductLabelEvent(work.exec, work.input.credentialOwnership, {
        ...sending,
        occurredAt: work.actor.now(),
      }),
    ).rejects.toThrow();
    expect(
      await appendProductLabelEvent(work.exec, work.input.credentialOwnership, {
        ...work.eventBase(2),
        kind: "sending",
      }),
    ).toBe("stale");
    expect((await stored())?.projection.latestSequence).toBe(2);
  });
});
