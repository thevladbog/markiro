import { readFileSync } from "node:fs";

import { buildSscc, formatSsccHri } from "@markiro/domain";
import { describe, expect, it, vi } from "vitest";

import {
  DISASSEMBLE_REASONS,
  MAX_REASON_TEXT_CHARS,
  OTHER_REASON,
  REPRINT_REASONS,
} from "../src/floor/exception-reasons.js";
import {
  readOpenJob,
  sendLabelJob,
  StaleJobError,
  type PrintJob,
} from "../src/floor/print/print-jobs.js";
import {
  awaitsCheck,
  checkLabel,
  confirmPrinted,
  LabelRenderError,
  NoPrinterError,
  printAgain,
  printerForAgain,
  skipLabel,
  UnresolvableJobError,
} from "../src/floor/print/print-resolution.js";
import { LocalDbError } from "../src/local/executor.js";
import { failingWrites, PAIRING, PREFIX, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import {
  closeBoxWithLabel,
  FIRST_SSCC,
  jobRows,
  manualRuntime,
  printingSettings,
  printStation,
  renderedText,
  resolveContext,
  spyRender,
  TSC,
  ZEBRA,
} from "./support/printing.js";

const supportModuleUrl = import.meta.url;

type Station = Awaited<ReturnType<typeof printStation>>;

/** The job after a first send that ended as `answer` says. */
async function sentOnce(
  at: Station,
  answer: Parameters<ReturnType<typeof fakeHardware>["releaseSend"]>[0],
): Promise<{ job: PrintJob; shell: ReturnType<typeof fakeHardware> }> {
  const job = await closeBoxWithLabel(at);
  const shell = fakeHardware(async () => answer);
  const { runtime } = manualRuntime(shell.hardware);
  return { job: await sendLabelJob(resolveContext(at.local, runtime), job), shell };
}

function context(at: Station, shell = fakeHardware()) {
  return resolveContext(at.local, manualRuntime(shell.hardware).runtime);
}

function template(at: Station) {
  const { id, rev, spec } = at.shift.snapshot.boxTemplate;
  return { id, rev, spec };
}

function outbox(at: Station) {
  return rows(at.db, "SELECT kind, payload FROM outbox WHERE kind <> 'scan' ORDER BY seq").map(
    (row) => ({ kind: row["kind"], payload: JSON.parse(String(row["payload"])) as unknown }),
  );
}

describe("the reasons of a box exception", () => {
  it("are the host's lists, word for word", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../proto/fixtures/exception-reasons.json", supportModuleUrl), "utf8"),
    ) as unknown;
    expect(fixture).toEqual({
      reprint: [...REPRINT_REASONS],
      disassemble: [...DISASSEMBLE_REASONS],
      other: OTHER_REASON,
      maxTextChars: MAX_REASON_TEXT_CHARS,
    });
  });
});

describe("the check of a printed label", () => {
  it("verifies the scan of the job's SSCC, with its record, in one write", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job } = await sentOnce(at, { sent: true });
    const result = await checkLabel(context(at), job, `]C100${FIRST_SSCC}`);
    expect(result).toMatchObject({ kind: "verified", job: { state: "verified" } });
    expect(outbox(at)).toEqual([
      expect.objectContaining({ kind: "box_closed" }),
      {
        kind: "box_label",
        payload: {
          id: "00000000-0000-4000-8000-000000000101",
          kind: "box_label",
          shiftId: at.shift.copy.id,
          operatorId: job.operatorId,
          data: { boxId: job.subjectId, outcome: "verified", at: "2026-10-08T06:30:01.000Z" },
        },
      },
    ]);
  });

  it("refuses another box's SSCC and a scan that is no SSCC, and writes nothing", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job } = await sentOnce(at, { sent: true });
    const other = buildSscc(0, PREFIX, 1501);
    await expect(checkLabel(context(at), job, other)).resolves.toEqual({
      kind: "mismatch",
      sscc: other,
    });
    await expect(
      checkLabel(context(at), job, formatSsccHri(FIRST_SSCC).slice(0, 10)),
    ).resolves.toEqual({ kind: "not_sscc" });
    await expect(checkLabel(context(at), job, "]d201046006820000132100001")).resolves.toEqual({
      kind: "not_sscc",
    });
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent" });
    expect(outbox(at).map((record) => record.kind)).toEqual(["box_closed"]);
  });

  it("is for a sent job that asked for it only", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: true });
    await expect(checkLabel(context(at), job, FIRST_SSCC)).rejects.toBeInstanceOf(
      UnresolvableJobError,
    );
  });
});

describe("going on without a label", () => {
  it("skips a waiting check, a failed job and an unknown one, each with its record", async () => {
    for (const [answer, verify] of [
      [{ sent: true }, true],
      [{ sent: false, code: "not_sent" }, false],
      [{ sent: false, code: "outcome_unknown" }, false],
    ] as const) {
      const at = await printStation({ verifyPrintedLabel: verify });
      const { job } = await sentOnce(at, answer);
      await expect(skipLabel(context(at), job)).resolves.toMatchObject({
        state: "skipped",
        errorCode: null,
      });
      expect(outbox(at).at(-1)).toMatchObject({
        kind: "box_label",
        payload: { data: { boxId: job.subjectId, outcome: "skipped" } },
      });
    }
  });

  it("is not for a job that is done with or on its way", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: true });
    await expect(skipLabel(context(at), job)).rejects.toBeInstanceOf(UnresolvableJobError);
    await expect(skipLabel(context(at), { ...job, state: "prepared" })).rejects.toBeInstanceOf(
      UnresolvableJobError,
    );
    await expect(skipLabel(context(at), { ...job, state: "sending" })).rejects.toBeInstanceOf(
      UnresolvableJobError,
    );
  });
});

describe("the label the operator sees printed", () => {
  it("turns an unknown job into a sent one, and the check comes next when the job asks", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job, shell } = await sentOnce(at, { sent: false, code: "outcome_unknown" });
    await expect(confirmPrinted(context(at, shell), job)).resolves.toMatchObject({
      state: "sent",
      errorCode: null,
      attempts: 1,
    });
    expect(shell.sends).toHaveLength(1);
  });

  it("is not for a failed job: nothing left the computer", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "not_sent" });
    await expect(confirmPrinted(context(at), job)).rejects.toBeInstanceOf(UnresolvableJobError);
  });
});

describe("printing again", () => {
  it("sends a failed job's own bytes again, without a reason or an exception", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "not_sent" });
    const shell = fakeHardware();
    const again = await printAgain(
      context(at, shell),
      job,
      { reason: null, printer: null },
      at.settings,
      template(at),
    );
    expect(again).toMatchObject({ state: "sent", attempts: 2 });
    expect(shell.sends).toEqual([{ target: ZEBRA.target, text: renderedText(ZEBRA, FIRST_SSCC) }]);
    expect(rows(at.db, "SELECT count(*) AS n FROM floor_exceptions")).toEqual([{ n: 0 }]);
  });

  it("never prints a label that may exist without the operator's reason", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "outcome_unknown" });
    const shell = fakeHardware();
    await expect(
      printAgain(
        context(at, shell),
        job,
        { reason: null, printer: null },
        at.settings,
        template(at),
      ),
    ).rejects.toBeInstanceOf(UnresolvableJobError);
    expect(shell.sends).toEqual([]);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown", attempts: 1 });
  });

  it("writes the reprint with its reason in the write that marks the job sending", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "outcome_unknown" });
    const shell = fakeHardware();
    shell.holdSends();
    const sending = printAgain(
      context(at, shell),
      job,
      { reason: "printer_jam", printer: null },
      at.settings,
      template(at),
    );
    await vi.waitFor(() => expect(shell.heldSends()).toBe(1));
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sending", attempts: 2 });
    expect(
      rows(
        at.db,
        "SELECT kind, box_id, reason_code, reason_text, operator_id FROM floor_exceptions",
      ),
    ).toEqual([
      {
        kind: "reprint",
        box_id: job.subjectId,
        reason_code: "printer_jam",
        reason_text: null,
        operator_id: job.operatorId,
      },
    ]);
    expect(outbox(at).at(-1)).toMatchObject({
      kind: "box_exception",
      payload: {
        data: {
          exception: "reprint",
          boxId: job.subjectId,
          codeHash: null,
          targetScannedAt: null,
          reasonCode: "printer_jam",
          reasonText: null,
        },
      },
    });
    shell.releaseSend({ sent: true });
    await expect(sending).resolves.toMatchObject({ state: "sent" });
  });

  it("reprints a sent label whose check did not read it, with a reason", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job } = await sentOnce(at, { sent: true });
    const shell = fakeHardware();
    await expect(
      printAgain(
        context(at, shell),
        job,
        { reason: "unreadable_label", printer: null },
        at.settings,
        template(at),
      ),
    ).resolves.toMatchObject({ state: "sent", verify: true, attempts: 2 });
    expect(shell.sends).toHaveLength(1);
  });

  it("renders again for a printer of another language or resolution, from the snapshot", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "not_sent" });
    const shell = fakeHardware();
    const render = spyRender();
    const again = await printAgain(
      context(at, shell),
      job,
      { reason: null, printer: TSC },
      at.settings,
      template(at),
      render,
    );
    expect(render).toHaveBeenCalledWith(at.shift.snapshot.boxTemplate.spec, job.fields, TSC);
    expect(again.printer).toEqual(TSC);
    expect(shell.sends).toEqual([{ target: TSC.target, text: renderedText(TSC, FIRST_SSCC) }]);
    // The same language and resolution keep the bytes: no render.
    const same = {
      ...ZEBRA,
      id: "zebra-2",
      target: { kind: "usb", printer: "ZDesigner" },
    } as const;
    const at2 = await printStation();
    const second = await sentOnce(at2, { sent: false, code: "not_sent" });
    const render2 = spyRender();
    await printAgain(
      context(at2),
      second.job,
      { reason: null, printer: same },
      at2.settings,
      template(at2),
      render2,
    );
    expect(render2).not.toHaveBeenCalled();
  });

  it("takes the job's printer as the settings have it now, then the purpose's printer", () => {
    const job = { printer: ZEBRA, purpose: "box" } as const;
    const moved = { ...ZEBRA, target: { kind: "tcp", host: "192.168.1.60", port: 9100 } } as const;
    expect(printerForAgain(job, printingSettings({ printers: [moved, TSC] }), null)).toEqual(moved);
    expect(
      printerForAgain(
        job,
        printingSettings({
          printers: [TSC],
          assignments: { box: "tsc", pallet: null, duplicate: null },
        }),
        null,
      ),
    ).toEqual(TSC);
    expect(printerForAgain(job, printingSettings({ printers: [TSC] }), null)).toBeNull();
    expect(printerForAgain(job, printingSettings(), TSC)).toEqual(TSC);
  });

  it("changes and sends nothing without a printer or a render, and refuses another template", async () => {
    const at = await printStation({ assignments: { box: null, pallet: null, duplicate: null } });
    const job = await closeBoxWithLabel(at);
    const shell = fakeHardware();
    await expect(
      printAgain(
        context(at, shell),
        job,
        { reason: null, printer: null },
        at.settings,
        template(at),
      ),
    ).rejects.toBeInstanceOf(NoPrinterError);
    await expect(
      printAgain(
        context(at, shell),
        job,
        { reason: null, printer: ZEBRA },
        at.settings,
        template(at),
        async () => {
          throw new Error("no canvas");
        },
      ),
    ).rejects.toBeInstanceOf(LabelRenderError);
    await expect(
      printAgain(context(at, shell), job, { reason: null, printer: ZEBRA }, at.settings, {
        ...template(at),
        rev: 63,
      }),
    ).rejects.toBeInstanceOf(UnresolvableJobError);
    expect(shell.sends).toEqual([]);
    expect(jobRows(at.db)[0]).toMatchObject({
      state: "failed",
      error_code: "printer_unconfigured",
      attempts: 0,
    });
  });
});

const OTHER_OPERATOR = "3f2a9c1e-5b7d-4e8f-8a6c-1d2e3f4a5b6c";

function exceptionRows(at: Station) {
  return rows(at.db, "SELECT count(*) AS n FROM floor_exceptions");
}

describe("what the check of a label reads", () => {
  it("is the SSCC however the scanner wraps it, and the job is done with after", async () => {
    for (const raw of [
      FIRST_SSCC,
      `(00)${FIRST_SSCC}`,
      `00${FIRST_SSCC}`,
      `]C100${FIRST_SSCC}`,
      `]C1(00)${FIRST_SSCC}`,
    ]) {
      const at = await printStation({ verifyPrintedLabel: true });
      const { job } = await sentOnce(at, { sent: true });
      await expect(checkLabel(context(at), job, raw)).resolves.toMatchObject({ kind: "verified" });
      await expect(readOpenJob(at.local, PAIRING, at.shift.copy.id)).resolves.toBeNull();
    }
  });

  it("asks for the scan of a sent job that was made to be checked, and of no other", () => {
    for (const state of [
      "prepared",
      "sending",
      "sent",
      "failed",
      "unknown",
      "verified",
      "skipped",
    ] as const) {
      expect(awaitsCheck({ state, verify: true })).toBe(state === "sent");
      expect(awaitsCheck({ state, verify: false })).toBe(false);
    }
  });
});

describe("decisions the job's state does not allow", () => {
  it("refuse the check of a label in every state but a sent one that waits for it", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job } = await sentOnce(at, { sent: true });
    for (const refused of [
      ...(["prepared", "sending", "failed", "unknown", "verified", "skipped"] as const).map(
        (state) => ({ ...job, state }),
      ),
      { ...job, verify: false },
    ]) {
      await expect(checkLabel(context(at), refused, FIRST_SSCC)).rejects.toBeInstanceOf(
        UnresolvableJobError,
      );
    }
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent" });
    expect(outbox(at).map((record) => record.kind)).toEqual(["box_closed"]);
  });

  it("refuse «printed» for every state but unknown, and a skip for a label that is done", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job } = await sentOnce(at, { sent: true });
    for (const state of ["prepared", "sending", "sent", "failed", "verified", "skipped"] as const) {
      await expect(confirmPrinted(context(at), { ...job, state })).rejects.toBeInstanceOf(
        UnresolvableJobError,
      );
    }
    for (const state of ["verified", "skipped"] as const) {
      await expect(skipLabel(context(at), { ...job, state })).rejects.toBeInstanceOf(
        UnresolvableJobError,
      );
    }
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent" });
    expect(outbox(at).map((record) => record.kind)).toEqual(["box_closed"]);
  });

  it("never print again a job that is waiting to be sent, on its way or done with", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: true });
    const shell = fakeHardware();
    // A sent label whose check was not asked for is done with: a reprint of it is plan 2a8's new job.
    for (const refused of [
      job,
      ...(["prepared", "sending", "verified", "skipped"] as const).map((state) => ({
        ...job,
        state,
      })),
    ]) {
      await expect(
        printAgain(
          context(at, shell),
          refused,
          { reason: "printer_jam", printer: null },
          at.settings,
          template(at),
        ),
      ).rejects.toBeInstanceOf(UnresolvableJobError);
    }
    expect(shell.sends).toEqual([]);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent", attempts: 1 });
    expect(exceptionRows(at)).toEqual([{ n: 0 }]);
  });

  it("leave a job alone that another pairing's decision reaches for", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job } = await sentOnce(at, { sent: true });
    const home = context(at);
    for (const pairing of [
      { ...PAIRING, hostId: "another-host" },
      { ...PAIRING, deviceId: "another-device" },
    ]) {
      await expect(checkLabel({ ...home, pairing }, job, FIRST_SSCC)).rejects.toBeInstanceOf(
        StaleJobError,
      );
    }
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent" });
    expect(outbox(at).map((record) => record.kind)).toEqual(["box_closed"]);
  });

  it("let one of two decisions on the same read win, and write one record", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job } = await sentOnce(at, { sent: true });
    const [first, second] = await Promise.allSettled([
      checkLabel(context(at), job, FIRST_SSCC),
      checkLabel(context(at), job, FIRST_SSCC),
    ]);
    expect(first).toMatchObject({ status: "fulfilled", value: { kind: "verified" } });
    expect(second).toMatchObject({ status: "rejected" });
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(StaleJobError);
    expect(outbox(at).map((record) => record.kind)).toEqual(["box_closed", "box_label"]);
    // A skip that read the job before the check finished does not undo it.
    await expect(skipLabel(context(at), job)).rejects.toBeInstanceOf(StaleJobError);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "verified" });
    expect(outbox(at).map((record) => record.kind)).toEqual(["box_closed", "box_label"]);
  });

  it("let a database failure through as it is, not as a job that changed", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const checked = await sentOnce(at, { sent: true });
    const unknown = await sentOnce(await printStation(), {
      sent: false,
      code: "outcome_unknown",
    });
    const broken = (shell = fakeHardware()) =>
      resolveContext(failingWrites(at.local), manualRuntime(shell.hardware).runtime);
    const shell = fakeHardware();
    for (const attempt of [
      () => checkLabel(broken(), checked.job, FIRST_SSCC),
      () => skipLabel(broken(), checked.job),
      () => confirmPrinted(broken(), unknown.job),
      () =>
        printAgain(
          broken(shell),
          unknown.job,
          { reason: "printer_jam", printer: null },
          at.settings,
          template(at),
        ),
    ]) {
      const failure = await attempt().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(LocalDbError);
    }
    expect(shell.sends).toEqual([]);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent" });
  });
});

describe("whose decision it is", () => {
  it("names the operator signed in on every record, not the one who closed the box", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job } = await sentOnce(at, { sent: true });
    expect(job.operatorId).not.toBe(OTHER_OPERATOR);
    const signedIn = { ...context(at), operatorId: OTHER_OPERATOR };
    await checkLabel(signedIn, job, FIRST_SSCC);
    expect(outbox(at).at(-1)).toMatchObject({
      kind: "box_label",
      payload: { operatorId: OTHER_OPERATOR },
    });

    const second = await printStation();
    const failed = await sentOnce(second, { sent: false, code: "not_sent" });
    await skipLabel({ ...context(second), operatorId: OTHER_OPERATOR }, failed.job);
    expect(outbox(second).at(-1)).toMatchObject({
      kind: "box_label",
      payload: { operatorId: OTHER_OPERATOR },
    });

    const third = await printStation();
    const unknown = await sentOnce(third, { sent: false, code: "outcome_unknown" });
    await printAgain(
      { ...context(third), operatorId: OTHER_OPERATOR },
      unknown.job,
      { reason: "quality_request", printer: null },
      third.settings,
      template(third),
    );
    expect(outbox(third).at(-1)).toMatchObject({
      kind: "box_exception",
      payload: { operatorId: OTHER_OPERATOR },
    });
    expect(rows(third.db, "SELECT operator_id FROM floor_exceptions")).toEqual([
      { operator_id: OTHER_OPERATOR },
    ]);
  });

  it("writes the reprint exactly: the shift, the box, the reason, the moment, no words", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job } = await sentOnce(at, { sent: true });
    await printAgain(
      context(at),
      job,
      { reason: "damaged_label", printer: null },
      at.settings,
      template(at),
    );
    expect(outbox(at).at(-1)).toEqual({
      kind: "box_exception",
      payload: {
        id: expect.any(String),
        kind: "box_exception",
        shiftId: at.shift.copy.id,
        operatorId: job.operatorId,
        data: {
          exception: "reprint",
          boxId: job.subjectId,
          codeHash: null,
          targetScannedAt: null,
          reasonCode: "damaged_label",
          reasonText: null,
          occurredAt: "2026-10-08T06:30:01.000Z",
        },
      },
    });
    expect(
      rows(at.db, "SELECT shift_id, host_id, device_id, occurred_at FROM floor_exceptions"),
    ).toEqual([
      {
        shift_id: at.shift.copy.id,
        host_id: PAIRING.hostId,
        device_id: PAIRING.deviceId,
        occurred_at: "2026-10-08T06:30:01.000Z",
      },
    ]);
  });
});

describe("«printed» and the check that follows", () => {
  it("leaves the check waiting when the job asks for it, and nothing when it does not", async () => {
    for (const verify of [true, false]) {
      const at = await printStation({ verifyPrintedLabel: verify });
      const { job } = await sentOnce(at, { sent: false, code: "outcome_unknown" });
      await confirmPrinted(context(at), job);
      const open = await readOpenJob(at.local, PAIRING, at.shift.copy.id);
      if (verify) expect(open).toMatchObject({ state: "sent", verify: true });
      else expect(open).toBeNull();
      expect(outbox(at).map((record) => record.kind)).toEqual(["box_closed"]);
    }
  });
});

describe("printing again, beyond the first cases", () => {
  it("writes no exception for a failed job, whatever reason the screen sent along", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "not_sent" });
    await expect(
      printAgain(
        context(at),
        job,
        { reason: "printer_jam", printer: null },
        at.settings,
        template(at),
      ),
    ).resolves.toMatchObject({ state: "sent", attempts: 2 });
    expect(exceptionRows(at)).toEqual([{ n: 0 }]);
    expect(outbox(at).map((record) => record.kind)).toEqual(["box_closed"]);
  });

  it("renders again when only the resolution or only the language is not the job's", async () => {
    for (const printer of [
      { ...ZEBRA, id: "zebra-300", dpi: 300 },
      { ...TSC, id: "tsc-203", dpi: 203 },
    ] as const) {
      const at = await printStation();
      const { job } = await sentOnce(at, { sent: false, code: "not_sent" });
      const shell = fakeHardware();
      const render = spyRender();
      await printAgain(
        context(at, shell),
        job,
        { reason: null, printer },
        at.settings,
        template(at),
        render,
      );
      expect(render).toHaveBeenCalledTimes(1);
      expect(shell.sends).toEqual([
        { target: printer.target, text: renderedText(printer, FIRST_SSCC) },
      ]);
    }
  });

  it("renders the label of a job that never had its bytes, for its printer or a chosen one", async () => {
    const withoutBytes = await printStation();
    const failedRender = await closeBoxWithLabel(withoutBytes, async () => {
      throw new Error("no canvas");
    });
    expect(failedRender).toMatchObject({ state: "failed", errorCode: "render_failed" });
    expect(failedRender.printer).toEqual(ZEBRA);
    const shell = fakeHardware();
    await expect(
      printAgain(
        context(withoutBytes, shell),
        failedRender,
        { reason: null, printer: null },
        withoutBytes.settings,
        template(withoutBytes),
        spyRender(),
      ),
    ).resolves.toMatchObject({ state: "sent", attempts: 1 });
    expect(shell.sends).toEqual([{ target: ZEBRA.target, text: renderedText(ZEBRA, FIRST_SSCC) }]);

    const unassigned = await printStation({
      assignments: { box: null, pallet: null, duplicate: null },
    });
    const noPrinter = await closeBoxWithLabel(unassigned);
    const second = fakeHardware();
    await expect(
      printAgain(
        context(unassigned, second),
        noPrinter,
        { reason: null, printer: TSC },
        unassigned.settings,
        template(unassigned),
        spyRender(),
      ),
    ).resolves.toMatchObject({ state: "sent", printer: TSC, attempts: 1 });
    expect(second.sends).toEqual([{ target: TSC.target, text: renderedText(TSC, FIRST_SSCC) }]);
  });

  it("sends nothing and changes nothing when the label will not render for the printer", async () => {
    const at = await printStation();
    const failed = await sentOnce(at, { sent: false, code: "not_sent" });
    const shell = fakeHardware();
    const broken = async () => {
      throw new Error("no canvas");
    };
    await expect(
      printAgain(
        context(at, shell),
        failed.job,
        { reason: null, printer: TSC },
        at.settings,
        template(at),
        broken,
      ),
    ).rejects.toBeInstanceOf(LabelRenderError);
    expect(jobRows(at.db)[0]).toMatchObject({
      state: "failed",
      attempts: 1,
      bytes_base64: failed.job.bytesBase64,
    });

    const second = await printStation();
    const unknown = await sentOnce(second, { sent: false, code: "outcome_unknown" });
    await expect(
      printAgain(
        context(second, shell),
        unknown.job,
        { reason: "printer_jam", printer: TSC },
        second.settings,
        template(second),
        broken,
      ),
    ).rejects.toBeInstanceOf(LabelRenderError);
    expect(jobRows(second.db)[0]).toMatchObject({ state: "unknown", attempts: 1 });
    expect(exceptionRows(second)).toEqual([{ n: 0 }]);
    expect(shell.sends).toEqual([]);
  });

  it("refuses the layout of another template, by id as well as by revision", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "outcome_unknown" });
    const shell = fakeHardware();
    await expect(
      printAgain(context(at, shell), job, { reason: "printer_jam", printer: ZEBRA }, at.settings, {
        ...template(at),
        id: "another-template",
      }),
    ).rejects.toBeInstanceOf(UnresolvableJobError);
    await expect(
      printAgain(context(at, shell), job, { reason: "printer_jam", printer: ZEBRA }, at.settings, {
        ...template(at),
        rev: template(at).rev + 1,
      }),
    ).rejects.toBeInstanceOf(UnresolvableJobError);
    expect(shell.sends).toEqual([]);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown", attempts: 1 });
    expect(exceptionRows(at)).toEqual([{ n: 0 }]);
  });

  it("writes no reprint for a job the operator moved on meanwhile, and sends nothing", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "outcome_unknown" });
    await skipLabel(context(at), job);
    const shell = fakeHardware();
    await expect(
      printAgain(
        context(at, shell),
        job,
        { reason: "printer_jam", printer: null },
        at.settings,
        template(at),
      ),
    ).rejects.toBeInstanceOf(StaleJobError);
    expect(shell.sends).toEqual([]);
    expect(exceptionRows(at)).toEqual([{ n: 0 }]);
    expect(outbox(at).map((record) => record.kind)).toEqual(["box_closed", "box_label"]);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "skipped", attempts: 1 });
  });

  it("lets one of two prints of the same read go to the printer, with one reprint", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "outcome_unknown" });
    const shell = fakeHardware();
    const request = { reason: "printer_jam", printer: null } as const;
    const [first, second] = await Promise.allSettled([
      printAgain(context(at, shell), job, request, at.settings, template(at)),
      printAgain(context(at, shell), job, request, at.settings, template(at)),
    ]);
    expect(first).toMatchObject({ status: "fulfilled", value: { state: "sent", attempts: 2 } });
    expect(second).toMatchObject({ status: "rejected" });
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(StaleJobError);
    expect(shell.sends).toHaveLength(1);
    expect(exceptionRows(at)).toEqual([{ n: 1 }]);
  });
});

describe("a pallet's label", () => {
  it("is not decided here: the records of a pallet are the pallets' plan's", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const { job } = await sentOnce(at, { sent: true });
    const shell = fakeHardware();
    const pallet = { ...job, purpose: "pallet" } as const;
    await expect(checkLabel(context(at), pallet, FIRST_SSCC)).rejects.toBeInstanceOf(
      UnresolvableJobError,
    );
    await expect(skipLabel(context(at), pallet)).rejects.toBeInstanceOf(UnresolvableJobError);
    await expect(
      printAgain(
        context(at, shell),
        pallet,
        { reason: "printer_jam", printer: null },
        at.settings,
        template(at),
      ),
    ).rejects.toBeInstanceOf(UnresolvableJobError);
    expect(shell.sends).toEqual([]);
    expect(exceptionRows(at)).toEqual([{ n: 0 }]);
    expect(outbox(at).map((record) => record.kind)).toEqual(["box_closed"]);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "sent", attempts: 1 });
  });
});

describe("a decision on an earlier read of the job", () => {
  it("does not confirm the label of a later attempt that looks the same", async () => {
    const at = await printStation();
    const { job } = await sentOnce(at, { sent: false, code: "outcome_unknown" });
    const again = await printAgain(
      context(
        at,
        fakeHardware(async () => ({ sent: false, code: "outcome_unknown" })),
      ),
      job,
      { reason: "printer_jam", printer: null },
      at.settings,
      template(at),
    );
    expect(again).toMatchObject({ state: "unknown", attempts: 2 });
    // The operator's screen still shows the first attempt, in the same state.
    await expect(confirmPrinted(context(at), job)).rejects.toBeInstanceOf(StaleJobError);
    expect(jobRows(at.db)[0]).toMatchObject({ state: "unknown", attempts: 2 });
    await expect(confirmPrinted(context(at), again)).resolves.toMatchObject({ state: "sent" });
  });

  it("gives every reprint of a box its own exception", async () => {
    const at = await printStation({ verifyPrintedLabel: true });
    const first = await sentOnce(at, { sent: true });
    // One session: its ids go on counting, as the app's do.
    const session = context(at);
    const second = await printAgain(
      session,
      first.job,
      { reason: "damaged_label", printer: null },
      at.settings,
      template(at),
    );
    await printAgain(
      session,
      second,
      { reason: "unreadable_label", printer: null },
      at.settings,
      template(at),
    );
    expect(
      rows(at.db, "SELECT reason_code FROM floor_exceptions ORDER BY occurred_at, id"),
    ).toEqual([{ reason_code: "damaged_label" }, { reason_code: "unreadable_label" }]);
    expect(outbox(at).map((record) => record.kind)).toEqual([
      "box_closed",
      "box_exception",
      "box_exception",
    ]);
  });
});
