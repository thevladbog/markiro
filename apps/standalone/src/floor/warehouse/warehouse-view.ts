import { canonicalizeKm } from "@markiro/domain";

import { shiftProductTitle } from "../../lib/shift-product.js";
import {
  resolvePrinter,
  type PrinterProfile,
  type PrintPurpose,
  type WorkstationSettings,
} from "../setup/workstation-settings.js";
import type { WarehouseSubjectKind } from "../../host/protocol.js";
import type { GlyphName } from "../kit/StatusIcons.js";
import { codeDisplay, SERIAL_FULL } from "../work/scan-history.js";
import type { WarehouseJob } from "./warehouse-store.js";

/**
 * The pure part of the reprint screens (design: station reprint, 2026-10): what the session's
 * journal, the job's detail and the summary of printers say, derived from the job as stored —
 * nothing here moves a state or reads the host, so every word and tone is tested without a screen.
 */

/** What a journal row is, as the operator sorts it: a pallet's A4 sheet is its own kind. */
export type JobKindView = "box" | "pallet" | "unit" | "sheet";

export const JOURNAL_FILTERS = ["all", "box", "pallet", "unit", "sheet"] as const;
export type JournalFilter = (typeof JOURNAL_FILTERS)[number];

/** `WarehouseSubjectKind`s as the kit's four rows: boxes, pallets, units, sheets. */
export function jobKindView(
  job: Pick<WarehouseJob, "kind" | "printer" | "errorCode">,
): JobKindView {
  if (job.kind !== "pallet") return job.kind;
  // A sheet is a pallet job made for a printer of sheets; one that met a printer of labels says so.
  return job.printer?.paper === "a4" || job.errorCode === "printer_not_a4" ? "sheet" : "pallet";
}

export function filterJobs<T extends Pick<WarehouseJob, "kind" | "printer" | "errorCode">>(
  jobs: readonly T[],
  filter: JournalFilter,
): T[] {
  return filter === "all" ? [...jobs] : jobs.filter((job) => jobKindView(job) === filter);
}

/** An 18-digit SSCC as the label prints it: «04 6070 1234 0000 4821»; anything else as it is. */
export function groupSscc(sscc: string): string {
  const match = /^(\d{2})(\d{4})(\d{4})(\d{4})(\d{4})$/.exec(sscc);
  return match === null ? sscc : match.slice(1).join(" ");
}

/** The code a row and the detail lead with. */
export interface JobCodeView {
  /** `serial`: a unit's AI 21 first; `sscc`: a box's or a pallet's; `unreadable`: no code to show. */
  kind: "serial" | "sscc" | "unreadable";
  main: string;
  /** A unit's GTIN, beside its serial. */
  gtin: string | null;
}

export function jobCode(job: Pick<WarehouseJob, "kind" | "identity" | "fields">): JobCodeView {
  if (job.kind !== "unit") return { kind: "sscc", main: groupSscc(job.identity), gtin: null };
  try {
    const km = canonicalizeKm(job.fields["km.code"]);
    const shown = codeDisplay(km.gtin14, km.serial, SERIAL_FULL);
    if (shown === null) return { kind: "unreadable", main: "", gtin: null };
    return { kind: "serial", main: shown.serial, gtin: km.gtin14 };
  } catch {
    return { kind: "unreadable", main: "", gtin: null };
  }
}

/** A journal row's words: the kind, the product's print name, and what the label counts. */
export interface JobRowParts {
  kind: JobKindView;
  title: string;
  count: { unit: "items" | "boxes"; n: number } | null;
}

function positive(text: string | undefined): number | null {
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function jobRowParts(job: WarehouseJob): JobRowParts {
  const kind = jobKindView(job);
  const title = shiftProductTitle({
    name: job.fields["product.name"],
    printName: job.fields["product.printName"],
  });
  let count: JobRowParts["count"] = null;
  if (kind === "box") {
    const n = positive(job.fields.qty);
    if (n !== null) count = { unit: "items", n };
  } else if (kind === "pallet") {
    const n = positive(job.fields["qty.boxes"]);
    if (n !== null) count = { unit: "boxes", n };
  }
  return { kind, title, count };
}

const TIME = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** The minute of an instant on this PC's clock, `ЧЧ:ММ`; nothing for text that is no instant. */
export function jobTime(instant: string): string {
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? "" : TIME.format(date);
}

export type TagTone = "ok" | "warn" | "error" | "info" | "neutral";

/** A job's tag: glyph, tone and the word's key under `floor.warehouse.tag`; never colour alone. */
export interface JobTag {
  tone: TagTone;
  glyph: GlyphName;
  key: "sent" | "verified" | "unknown" | "failed" | "prepared" | "sending" | "cancelled";
}

export function jobTag(job: Pick<WarehouseJob, "state">): JobTag {
  switch (job.state) {
    case "sent":
      return { tone: "ok", glyph: "check-circle", key: "sent" };
    case "verified":
      return { tone: "neutral", glyph: "check-circle", key: "verified" };
    case "unknown":
      return { tone: "warn", glyph: "question-circle", key: "unknown" };
    case "failed":
      return { tone: "error", glyph: "x-circle", key: "failed" };
    case "prepared":
      return { tone: "info", glyph: "printer", key: "prepared" };
    case "sending":
      return { tone: "info", glyph: "circle-notch", key: "sending" };
    case "cancelled":
      return { tone: "neutral", glyph: "x-circle", key: "cancelled" };
  }
}

/** One line of the left column of the detail: the key of its label, and its value. */
export interface JobFact {
  key: "quantity" | "boxes" | "productionDate" | "shift" | "counterparty";
  value: string;
}

/** The facts the detail has room for: the most that stand beside the code without a scroll. */
const FACTS_SHOWN = 4;

/**
 * What the label says of its subject (the job's frozen fields); a line the label lacks is left
 * out, and no more than `FACTS_SHOWN` stand (the counterparty is the first to give way).
 */
export function jobFacts(job: Pick<WarehouseJob, "kind" | "fields">): JobFact[] {
  const { fields } = job;
  const facts: JobFact[] = [];
  const add = (key: JobFact["key"], value: string | undefined) => {
    if (value !== undefined && value.trim() !== "") facts.push({ key, value });
  };
  if (job.kind === "pallet") add("boxes", fields["qty.boxes"]);
  if (job.kind !== "unit") add("quantity", fields.qty);
  add("productionDate", fields.date);
  add("shift", fields["shift.no"]);
  add("counterparty", fields["counterparty.name"]);
  return facts.slice(0, FACTS_SHOWN);
}

/** The codes a failed job carries when the printer, not the label, is what is missing. */
const SETUP_FAILURES = ["printer_unconfigured", "printer_a4", "printer_not_a4"] as const;
type SetupFailure = (typeof SETUP_FAILURES)[number];

export function isPrinterSetupFailure(code: string | null): code is SetupFailure {
  return code !== null && (SETUP_FAILURES as readonly string[]).includes(code);
}

/**
 * The session's check of a print by a second scan of the new label (the equipment's own
 * `verifyPrintedLabel` is its default, as the duplicate's `verificationPolicy` is the shift's):
 * `required` holds the next code of a sent label until the new label is scanned.
 */
export type ReprintCheck = "none" | "required";

/** A job that waits for the printer or the operator: no other work, and no end of the session, beside it. */
export function isUnresolved(job: Pick<WarehouseJob, "state">): boolean {
  return (
    job.state === "prepared" ||
    job.state === "sending" ||
    job.state === "failed" ||
    job.state === "unknown"
  );
}

/** Whether a job stands at the check: a label sent while the session requires the scan of the new one. */
export function awaitsCheck(job: Pick<WarehouseJob, "state">, check: ReprintCheck): boolean {
  return check === "required" && job.state === "sent";
}

/** The answer block of the detail: a glyph, a title (a key of `floor.warehouse.status`) and a body. */
export interface ResultView {
  tone: TagTone;
  glyph: GlyphName;
  title: string;
  body: { kind: "hint"; key: string } | { kind: "code"; code: string } | null;
}

export function resultView(
  job: Pick<WarehouseJob, "state" | "errorCode">,
  verifying: boolean,
): ResultView {
  if (verifying) {
    return {
      tone: "info",
      glyph: "scan-frame",
      title: "verify",
      body: { kind: "hint", key: "verify" },
    };
  }
  switch (job.state) {
    case "sending":
      return {
        tone: "info",
        glyph: "circle-notch",
        title: "sending",
        body: { kind: "hint", key: "sending" },
      };
    case "sent":
      return {
        tone: "ok",
        glyph: "check-circle",
        title: "sent",
        body: { kind: "hint", key: "sent" },
      };
    case "verified":
      return { tone: "ok", glyph: "check-circle", title: "verified", body: null };
    case "unknown":
      return {
        tone: "warn",
        glyph: "question-circle",
        title: "unknown",
        body: { kind: "hint", key: "unknown" },
      };
    case "failed": {
      const body = job.errorCode === null ? null : ({ kind: "code", code: job.errorCode } as const);
      if (isPrinterSetupFailure(job.errorCode)) {
        const title =
          job.errorCode === "printer_unconfigured"
            ? "printerUnconfigured"
            : job.errorCode === "printer_a4"
              ? "printerA4"
              : "printerNotA4";
        return { tone: "warn", glyph: "warning", title, body };
      }
      return { tone: "error", glyph: "x-circle", title: "failed", body };
    }
    case "cancelled":
      return { tone: "neutral", glyph: "x-circle", title: "cancelled", body: null };
    case "prepared":
      return { tone: "info", glyph: "printer", title: "prepared", body: null };
  }
}

/** The printer row of the detail: its name (none when the job has none) and the tag beside it. */
export interface PrinterView {
  name: string | null;
  tag: "ready" | "accepting" | "error" | "unassigned";
}

export function printerView(
  job: Pick<WarehouseJob, "state" | "errorCode" | "printer">,
): PrinterView {
  const name = job.printer?.name ?? null;
  if (job.state === "sending") return { name, tag: "accepting" };
  if (job.state === "failed") {
    return { name, tag: isPrinterSetupFailure(job.errorCode) ? "unassigned" : "error" };
  }
  return { name, tag: "ready" };
}

/** The printer purpose of each kind of label (the print pipeline's own table). */
const PURPOSE: Record<WarehouseSubjectKind, PrintPurpose> = {
  unit: "duplicate",
  box: "box",
  pallet: "pallet",
};

/**
 * One row of «Что и на чём печатаем»: `ready` — a printer is assigned; `unassigned` — none; and
 * for the pallets' label `sheets_only` — the pallets' printer prints A4 sheets, so no label goes
 * to it (the sheet row has that printer).
 */
export interface SummaryRow {
  kind: JobKindView;
  state: "ready" | "unassigned" | "sheets_only";
  printer: PrinterProfile | null;
}

export function summaryRows(
  settings: Pick<WorkstationSettings, "printers" | "assignments">,
): SummaryRow[] {
  const box = resolvePrinter(settings, PURPOSE.box);
  const pallet = resolvePrinter(settings, PURPOSE.pallet);
  const unit = resolvePrinter(settings, PURPOSE.unit);
  const row = (kind: JobKindView, printer: PrinterProfile | null): SummaryRow => ({
    kind,
    state: printer === null ? "unassigned" : "ready",
    printer,
  });
  const sheets = pallet?.paper === "a4";
  return [
    row("box", box),
    sheets ? { kind: "pallet", state: "sheets_only", printer: pallet } : row("pallet", pallet),
    row("unit", unit),
    row("sheet", sheets ? pallet : null),
  ];
}
