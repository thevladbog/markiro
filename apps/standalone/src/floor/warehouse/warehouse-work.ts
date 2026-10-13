import {
  boxLabelFields,
  compareWarehouseReprintLabel,
  DomainError,
  kmHash,
  labelTemplateSpecSchema,
  palletLabelFields,
  parseDuplicateKm,
  resolveWarehouseReprintScan,
  type LabelTemplateSpec,
} from "@markiro/domain";

import { shellActionFor } from "../../app/shell.js";
import { bytesToBase64 } from "../../hardware/hardware.js";
import { HostError } from "../../host/client.js";
import type {
  WarehouseLookup,
  WarehouseLookupResult,
  WarehouseSource,
  WarehouseSubjectKind,
} from "../../host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { LabelFields, LabelPrinter } from "../print/label-render.js";
import { base64ToBytes, settleOutcome } from "../print/print-jobs.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import { renderLogoLabel, type ShiftRenderDeps } from "../print/shift-render.js";
import {
  printerMode,
  readWorkstationSettings,
  resolvePrinter,
  type PrintPurpose,
  type PrinterProfile,
  type WorkstationSettings,
} from "../setup/workstation-settings.js";
import { readOperatorCopy } from "../sign-in.js";
import { readKnownOrganizationLogo } from "./warehouse-logo.js";
import { checkTemplate, readWarehouseTemplates } from "./warehouse-templates.js";
import {
  insertJobStatement,
  moveJobStatement,
  readJob,
  readJobByIdentity,
  readOpenJob,
  recordStatement,
  StaleWarehouseError,
  warehouseRecord,
  type JobMove,
  type NewWarehouseJob,
  type WarehouseJob,
  type WarehouseOutcome,
  type WarehouseReason,
  type WarehouseRepair,
  type WarehouseSession,
} from "./warehouse-store.js";

/** How a label printed again is rendered: `warehouseLabelRender` by default, a test's own otherwise. */
export type RenderWarehouseLabel = (
  spec: LabelTemplateSpec,
  fields: LabelFields,
  printer: LabelPrinter,
  options: { kmDataMatrix?: "native" | "raster" },
) => Promise<Uint8Array>;

/**
 * The app's render of a label printed again (plan СКЛ × А4): the shift labels'
 * own rule (`renderLogoLabel`) — the organization logo the station knows now
 * (`readKnownOrganizationLogo`: the newest shift snapshot that froze it), else
 * the bundled Markiro logo — and `renderLabel`'s choice per printer: a RAW
 * label in its language, or a `mono-raster-v1` page for a printer in driver
 * mode with the bundled face only (`rasterizeDriverText`), never a fallback
 * face. `deps` replaces the app's rasterizer and logo loaders (tests).
 */
export function warehouseLabelRender(
  local: LocalExecutor,
  pairing: Pairing,
  deps: ShiftRenderDeps = {},
): RenderWarehouseLabel {
  return (spec, fields, printer, options) =>
    renderLogoLabel(
      spec,
      fields,
      printer,
      () => readKnownOrganizationLogo(local, pairing),
      deps,
      options,
    );
}

/** What the warehouse work needs: the database, the pairing, the printers, a clock, ids. */
export interface WarehouseContext {
  local: LocalExecutor;
  pairing: Pairing;
  runtime: PrintRuntime;
  now: () => Date;
  newId: () => string;
  /** The whole render, replaced (tests); left out, `warehouseLabelRender` with `labelDeps`. */
  render?: RenderWarehouseLabel;
  /** What the app's render takes instead of its own rasterizer and logo loaders (tests). */
  labelDeps?: ShiftRenderDeps;
}

function renderOf(context: WarehouseContext): RenderWarehouseLabel {
  return context.render ?? warehouseLabelRender(context.local, context.pairing, context.labelDeps);
}

/** The printer purpose of each kind (decision Р14). */
const PRINT_PURPOSE: Record<WarehouseSubjectKind, PrintPurpose> = {
  unit: "duplicate",
  box: "box",
  pallet: "pallet",
};

/** A unit's code is drawn as the GS1 raster; a box's and a pallet's barcodes natively. */
function renderOptions(kind: WarehouseSubjectKind): { kmDataMatrix?: "raster" } {
  return kind === "unit" ? { kmDataMatrix: "raster" } : {};
}

/**
 * Why a label cannot go to a printer: none is assigned to its kind
 * (`printer_unconfigured`), the one assigned prints A4 sheets (`printer_a4`,
 * plan А4: a warehouse reprint is a thermal label — a box's, a unit's or a
 * pallet's — and never an A4 sheet, which only a shift's own pallet close
 * prints from its frozen snapshot), or the label does not render for it.
 */
export type WarehousePrinterCode = "printer_unconfigured" | "printer_a4" | "render_failed";

/** A retry or a new attempt has no printer for its kind, or its label does not render for it. */
export class WarehousePrinterError extends Error {
  readonly code: WarehousePrinterCode;
  constructor(code: WarehousePrinterCode) {
    super(`warehouse print: ${code}`);
    this.name = "WarehousePrinterError";
    this.code = code;
  }
}

/**
 * The printer a label of `kind` prints on, as the settings assign it now: an
 * A4 printer — which only the purpose «Паллета» may have — is no printer for a
 * warehouse reprint (`printer_a4`), so neither a thermal page reaches an A4
 * printer nor an A4 page comes from this path.
 */
function warehousePrinter(
  settings: Pick<WorkstationSettings, "printers" | "assignments">,
  kind: WarehouseSubjectKind,
): { printer: PrinterProfile } | { error: "printer_unconfigured" | "printer_a4" } {
  const printer = resolvePrinter(settings, PRINT_PURPOSE[kind]);
  if (printer === null) return { error: "printer_unconfigured" };
  if (printer.paper === "a4") return { error: "printer_a4" };
  return { printer };
}

/**
 * The host refuses a record whose attempt number is above this (`warehouse_reprints`
 * rule): a label printed 10000 times could never be reported, and its session never
 * finish for the host. Far beyond any real use.
 */
export const MAX_WAREHOUSE_ATTEMPTS = 10_000;

/** A job that has no attempts left to record. */
export class WarehouseAttemptsError extends Error {
  constructor(id: string) {
    super(`warehouse job ${id} has used its attempts`);
    this.name = "WarehouseAttemptsError";
  }
}

/** A job that cannot take this action in its state. */
export class WarehouseStateError extends Error {
  constructor(id: string, state: string) {
    super(`warehouse job ${id} cannot do this from ${state}`);
    this.name = "WarehouseStateError";
  }
}

/** What a scan of the warehouse mode asks: a code's hash or an SSCC (a legacy `!1` label repaired). */
export type WarehouseScan =
  | { kind: "code"; codeHash: string }
  | { kind: "sscc"; sscc: string; repair: WarehouseRepair | null }
  | { kind: "invalid" };

/** The domain's warehouse rule (`resolveWarehouseReprintScan`): strict, `!1` only before an SSCC. */
export function readWarehouseScan(raw: string): WarehouseScan {
  const scan = resolveWarehouseReprintScan(raw);
  if (scan.kind === "unit") return { kind: "code", codeHash: scan.codeHash };
  if (scan.kind === "box") return { kind: "sscc", sscc: scan.sscc, repair: scan.repair };
  return { kind: "invalid" };
}

/** How the host answered a lookup, or why it did not. */
export type LookupAnswer =
  | { kind: "found"; source: WarehouseSource }
  | { kind: "not_found" }
  | { kind: "unavailable"; reason: "released" | "disassembled" }
  | { kind: "offline" }
  | { kind: "host_outdated" }
  | { kind: "restore_pending" }
  | { kind: "lookup_failed" }
  | { kind: "host_error"; error: unknown };

/**
 * Asks the host (decision Р2). A transport failure is `offline` — never «not found»;
 * a host without the route (`not_found`) is too old; a restored host holds the
 * route; a refused key or a changed certificate is the shell's (`host_error`).
 */
export async function lookUp(
  ask: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>,
  scan: Exclude<WarehouseScan, { kind: "invalid" }>,
): Promise<LookupAnswer> {
  const identity = scan.kind === "code" ? scan.codeHash : scan.sscc;
  try {
    const result = await ask(
      scan.kind === "code" ? { codeHash: scan.codeHash } : { sscc: scan.sscc },
    );
    if (result.status === "found") {
      // An answer for something else is no answer for this label: another
      // identity, or a box or pallet for a code, a unit for an SSCC.
      const fits =
        scan.kind === "code" ? result.source.kind === "unit" : result.source.kind !== "unit";
      return result.source.identity === identity && fits
        ? { kind: "found", source: result.source }
        : { kind: "lookup_failed" };
    }
    if (result.status === "not_found") return { kind: "not_found" };
    return { kind: "unavailable", reason: result.reason };
  } catch (error) {
    if (shellActionFor(error, null) !== null) return { kind: "host_error", error };
    if (error instanceof HostError) {
      if (error.kind === "transport") {
        return error.code === "invalid_response" ? { kind: "lookup_failed" } : { kind: "offline" };
      }
      if (error.code === "not_found") return { kind: "host_outdated" };
      if (error.code === "restore_pending") return { kind: "restore_pending" };
    }
    return { kind: "lookup_failed" };
  }
}

/** A unit whose stored code has no crypto tail, or another product's code. */
export class IncompleteCodeError extends Error {
  constructor() {
    super("the stored code cannot be printed");
    this.name = "IncompleteCodeError";
  }
}

/**
 * The label's fields from the host's record (decision Р15): the shift's product,
 * counterparty, number and production date, the record's own instant — so the
 * production and expiry dates are the historical ones — its counts and operator.
 * A unit's label carries its full canonical code (`parseDuplicateKm` refuses one
 * without a crypto tail) and a quantity of one, as the cloud's duplicate.
 */
export function sourceFields(source: WarehouseSource): LabelFields {
  const base = {
    productName: source.product.name,
    productPrintName: source.product.printName,
    gtin14: source.product.gtin14,
    // The code the record's shift froze (plan ТОВ), as its first label printed it.
    egaisCode: source.product.egaisCode ?? null,
    shelfLifeDays: source.product.shelfLifeDays,
    operatorName: source.operatorName,
    counterpartyName: source.counterpartyName,
    closedAt: source.at,
    productionDate: source.productionDate,
    shiftNumber: source.shiftNumber,
  };
  if (source.kind === "unit") {
    const km = parseDuplicateKm(source.canonical ?? "");
    if (km.gtin14 !== source.product.gtin14) throw new IncompleteCodeError();
    // The code printed is the code looked up: a reprint never makes a new identity.
    if (kmHash(km) !== source.identity) throw new IncompleteCodeError();
    return {
      ...boxLabelFields({ ...base, sscc: "", itemCount: 1 }),
      "km.code": km.raw,
      qty: "1",
      sscc: "",
    };
  }
  const sscc = source.sscc ?? "";
  if (sscc !== source.identity) throw new IncompleteCodeError();
  if (source.kind === "box") return boxLabelFields({ ...base, sscc, itemCount: source.itemCount });
  return palletLabelFields({
    ...base,
    sscc,
    boxCount: source.boxCount ?? 0,
    itemCount: source.itemCount,
  });
}

/** Why a found record was not made into a job. */
export type PrepareRefusal =
  | "incomplete_km"
  | "no_template"
  | "template_unavailable"
  | "template_unfit"
  | "operator_denied"
  | "busy";

export type PrepareResult =
  { kind: "job"; job: WarehouseJob } | { kind: "refused"; reason: PrepareRefusal };

/**
 * Makes the job of a found record (decisions Р8, Р13, Р14): the operator checked
 * against the copies as they are now, the label's fields, the session's template
 * of the kind checked, the printer of the kind, the bytes rendered for it. One
 * transaction writes the job — `prepared`, or `failed` with its reason (and that
 * attempt's record) when no printer is assigned or the label does not render.
 */
export async function prepareWarehouseJob(
  context: WarehouseContext,
  input: {
    session: WarehouseSession;
    source: WarehouseSource;
    repair: WarehouseRepair | null;
    operatorId: string;
  },
): Promise<PrepareResult> {
  const { local, pairing } = context;
  const { session, source } = input;
  const copy = await readOperatorCopy(
    { local, pairing, now: () => context.now().getTime() },
    input.operatorId,
  );
  if (copy.kind !== "present") return { kind: "refused", reason: "operator_denied" };
  let fields: LabelFields;
  try {
    fields = sourceFields(source);
  } catch (error) {
    if (error instanceof DomainError || error instanceof IncompleteCodeError) {
      return { kind: "refused", reason: "incomplete_km" };
    }
    throw error;
  }
  const check = checkTemplate(
    await readWarehouseTemplates(local),
    session.templates[source.kind],
    source.kind,
    source.product.chzProductGroupCode,
  );
  if (check.kind !== "ok") return { kind: "refused", reason: check.kind };
  if ((await readOpenJob(local, pairing, session.id)) !== null) {
    return { kind: "refused", reason: "busy" };
  }
  const assigned = warehousePrinter(await readWorkstationSettings(local), source.kind);
  const printer = "printer" in assigned ? assigned.printer : null;
  let bytes: string | null = null;
  let error: WarehousePrinterCode | null = "error" in assigned ? assigned.error : null;
  if (printer !== null) {
    try {
      bytes = bytesToBase64(
        await renderOf(context)(check.spec, fields, printer, renderOptions(source.kind)),
      );
    } catch {
      error = "render_failed";
    }
  }
  const at = context.now().toISOString();
  const job: NewWarehouseJob = {
    id: context.newId(),
    sessionId: session.id,
    kind: source.kind,
    subjectId: source.subjectId,
    identity: source.identity,
    repair: input.repair,
    reason: session.reason,
    state: error === null ? "prepared" : "failed",
    templateId: check.template.id,
    templateRev: check.template.rev,
    templateSpec: JSON.stringify(check.spec),
    fields,
    printer: bytes === null ? null : printer,
    bytesBase64: bytes,
    errorCode: error,
    operatorId: input.operatorId,
    createdAt: at,
  };
  try {
    await local.transaction([
      insertJobStatement(pairing, job),
      ...(error === null
        ? []
        : [
            recordStatement(
              pairing,
              warehouseRecord(job, {
                id: context.newId(),
                attempt: 0,
                reason: session.reason,
                outcome: "failed",
                errorCode: error,
                operatorId: input.operatorId,
                occurredAt: at,
              }),
              at,
            ),
          ]),
    ]);
  } catch (failure) {
    // Another job of the session took the one place (`wh_jobs_open`) meanwhile.
    if (
      failure instanceof LocalDbError &&
      (await readOpenJob(local, pairing, session.id)) !== null
    ) {
      return { kind: "refused", reason: "busy" };
    }
    throw failure;
  }
  const stored = await readJob(local, pairing, job.id);
  if (stored === null) throw new StaleWarehouseError(job.id);
  return { kind: "job", job: stored };
}

/** Which send: the first of a prepared job, a retry of a failed one, a new attempt with a reason. */
export type SendIntent =
  { kind: "first" } | { kind: "retry" } | { kind: "again"; reason: WarehouseReason };

const SEND_FROM: Record<SendIntent["kind"], readonly WarehouseJob["state"][]> = {
  first: ["prepared"],
  retry: ["failed"],
  again: ["sent", "verified", "unknown"],
};

async function moveAndRecord(
  context: WarehouseContext,
  job: WarehouseJob,
  move: JobMove,
  outcome: WarehouseOutcome,
  operatorId: string,
): Promise<WarehouseJob> {
  const { local, pairing } = context;
  const at = context.now().toISOString();
  try {
    await local.transaction([
      moveJobStatement(pairing, job, move, at),
      recordStatement(
        pairing,
        warehouseRecord(job, {
          id: context.newId(),
          attempt: move.attempts,
          reason: move.reason,
          outcome,
          errorCode: move.errorCode,
          operatorId,
          occurredAt: at,
        }),
        at,
      ),
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleWarehouseError(job.id);
    }
    throw error;
  }
  const after = await readJob(local, pairing, job.id);
  if (after === null) throw new StaleWarehouseError(job.id);
  return after;
}

/**
 * Sends a job (decisions Р11, Р14). `sending` and one more attempt are written
 * before the bytes go — with the new printer and bytes of a retry or a new
 * attempt — so a crash in between leaves `sending`, which the next opening reads
 * as `unknown`. Then one send through the runtime and one write of where it
 * ended with that attempt's record: `sent` only on the shell's `{ sent: true }`.
 * A retry or a new attempt prints on the printer assigned now; the label is
 * rendered again from the frozen template and fields only when that printer's
 * mode, language or resolution differs from the bytes' (a retry of a job with no
 * bytes always renders), so RAW bytes never reach a driver queue nor a driver
 * page a RAW printer. The bytes go through the runtime in the printer's mode —
 * the shell's Windows driver for a driver profile, as the floor's labels do. A
 * printer of A4 sheets is refused (`printer_a4`) before anything is written.
 * Nothing here sends again by itself.
 */
export async function sendWarehouseJob(
  context: WarehouseContext,
  job: WarehouseJob,
  intent: SendIntent,
  operatorId: string,
): Promise<WarehouseJob> {
  const { local, pairing } = context;
  if (!SEND_FROM[intent.kind].includes(job.state)) throw new WarehouseStateError(job.id, job.state);
  const attempt = job.attempts + 1;
  if (attempt > MAX_WAREHOUSE_ATTEMPTS) throw new WarehouseAttemptsError(job.id);
  let printer: PrinterProfile | null = job.printer;
  let bytes = job.bytesBase64;
  if (intent.kind !== "first") {
    const resolved = warehousePrinter(await readWorkstationSettings(local), job.kind);
    if ("error" in resolved) throw new WarehousePrinterError(resolved.error);
    const assigned = resolved.printer;
    if (
      bytes === null ||
      printer === null ||
      printerMode(printer) !== printerMode(assigned) ||
      printer.language !== assigned.language ||
      printer.dpi !== assigned.dpi
    ) {
      const spec = labelTemplateSpecSchema.safeParse(JSON.parse(job.templateSpec));
      if (!spec.success) throw new WarehousePrinterError("render_failed");
      try {
        bytes = bytesToBase64(
          await renderOf(context)(spec.data, job.fields, assigned, renderOptions(job.kind)),
        );
      } catch {
        throw new WarehousePrinterError("render_failed");
      }
    }
    printer = assigned;
  }
  if (printer === null || bytes === null) throw new WarehouseStateError(job.id, job.state);
  // A job prepared for an A4 printer by a build before this rule: never sent from here.
  if (printer.paper === "a4") throw new WarehousePrinterError("printer_a4");
  const reason = intent.kind === "again" ? intent.reason : job.reason;
  try {
    await local.transaction([
      moveJobStatement(
        pairing,
        job,
        {
          state: "sending",
          errorCode: null,
          attempts: attempt,
          reason,
          printer,
          bytesBase64: bytes,
        },
        context.now().toISOString(),
      ),
    ]);
  } catch (error) {
    if (error instanceof LocalDbError && error.code === "changes_mismatch") {
      throw new StaleWarehouseError(job.id);
    }
    throw error;
  }
  const outcome = await context.runtime.send(
    job.id,
    printer.target,
    base64ToBytes(bytes),
    printerMode(printer),
    printer.paper,
  );
  const settled = settleOutcome(outcome);
  const sending: WarehouseJob = {
    ...job,
    state: "sending",
    attempts: attempt,
    reason,
    printer,
    bytesBase64: bytes,
    errorCode: null,
  };
  return moveAndRecord(
    context,
    sending,
    {
      state: settled.state,
      errorCode: settled.state === "sent" ? null : settled.code,
      attempts: attempt,
      reason,
      printer,
      bytesBase64: bytes,
    },
    settled.state,
    operatorId,
  );
}

/**
 * Checks a sent or unknown label by a scan of the new label (decision Р11): the
 * domain's strict comparison — the old `!1` label is `invalid`, never a match.
 */
export async function verifyWarehouseJob(
  context: WarehouseContext,
  job: WarehouseJob,
  raw: string,
  operatorId: string,
): Promise<{ kind: "verified"; job: WarehouseJob } | { kind: "mismatch" } | { kind: "invalid" }> {
  if (job.state !== "sent" && job.state !== "unknown")
    throw new WarehouseStateError(job.id, job.state);
  const expected =
    job.kind === "unit"
      ? { kind: "unit" as const, canonicalRaw: job.fields["km.code"] }
      : { kind: "box" as const, sscc: job.identity };
  const answer = compareWarehouseReprintLabel(expected, raw);
  if (answer !== "match") return { kind: answer };
  const verified = await moveAndRecord(
    context,
    job,
    {
      state: "verified",
      errorCode: null,
      attempts: job.attempts,
      reason: job.reason,
      printer: job.printer,
      bytesBase64: job.bytesBase64,
    },
    "verified",
    operatorId,
  );
  return { kind: "verified", job: verified };
}

/** Cancels a failed job: nothing left this computer, so nothing may exist. */
export async function cancelWarehouseJob(
  context: WarehouseContext,
  job: WarehouseJob,
  operatorId: string,
): Promise<WarehouseJob> {
  if (job.state !== "failed") throw new WarehouseStateError(job.id, job.state);
  return moveAndRecord(
    context,
    job,
    {
      state: "cancelled",
      errorCode: null,
      attempts: job.attempts,
      reason: job.reason,
      printer: job.printer,
      bytesBase64: job.bytesBase64,
    },
    "cancelled",
    operatorId,
  );
}

/**
 * The session's waiting job when the screen opens: one found in `sending` whose
 * bytes no send of this app holds is `unknown` (`interrupted`) — the app stopped
 * after the bytes may have gone. Run only from the screen's work queue, never
 * beside a send of it.
 */
export async function recoverWarehouseJob(
  context: WarehouseContext,
  sessionId: string,
  operatorId: string,
): Promise<WarehouseJob | null> {
  const job = await readOpenJob(context.local, context.pairing, sessionId);
  if (job === null || job.state !== "sending" || context.runtime.isInFlight(job.id)) return job;
  return moveAndRecord(
    context,
    job,
    {
      state: "unknown",
      errorCode: "interrupted",
      attempts: job.attempts,
      reason: job.reason,
      printer: job.printer,
      bytesBase64: job.bytesBase64,
    },
    "unknown",
    operatorId,
  );
}

/** What a scan of the warehouse mode came to. */
export type ScanOutcome =
  | { kind: "invalid_scan" }
  | { kind: "busy"; job: WarehouseJob }
  | { kind: "duplicate"; job: WarehouseJob }
  | { kind: "offline" }
  | { kind: "host_outdated" }
  | { kind: "restore_pending" }
  | { kind: "lookup_failed" }
  | { kind: "not_found" }
  | { kind: "unavailable"; reason: "released" | "disassembled" }
  | { kind: "host_error"; error: unknown }
  | { kind: "refused"; reason: PrepareRefusal }
  | { kind: "printed"; job: WarehouseJob; repair: WarehouseRepair | null };

/**
 * One scan (or a typed code) of the warehouse mode: read by the domain's warehouse
 * rule; refused while a job of the session waits; a code the session printed is a
 * `duplicate` (no host, no print); without the link nothing is looked up
 * (`offline`); otherwise the host finds the record, the job is made and, prepared,
 * sent once. Run from the screen's work queue, one scan at a time.
 */
export async function reprintScan(
  context: WarehouseContext,
  input: {
    session: WarehouseSession;
    raw: string;
    operatorId: string;
    online: boolean;
    ask: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>;
  },
): Promise<ScanOutcome> {
  const { local, pairing } = context;
  const scan = readWarehouseScan(input.raw);
  if (scan.kind === "invalid") return { kind: "invalid_scan" };
  const waiting = await readOpenJob(local, pairing, input.session.id);
  if (waiting !== null) return { kind: "busy", job: waiting };
  const identity = scan.kind === "code" ? scan.codeHash : scan.sscc;
  const earlier = await readJobByIdentity(local, pairing, input.session.id, identity);
  if (earlier !== null) return { kind: "duplicate", job: earlier };
  if (!input.online) return { kind: "offline" };
  const answer = await lookUp(input.ask, scan);
  if (answer.kind !== "found") return answer;
  const repair = scan.kind === "sscc" ? scan.repair : null;
  const prepared = await prepareWarehouseJob(context, {
    session: input.session,
    source: answer.source,
    repair,
    operatorId: input.operatorId,
  });
  if (prepared.kind === "refused") return prepared;
  const job =
    prepared.job.state === "prepared"
      ? await sendWarehouseJob(context, prepared.job, { kind: "first" }, input.operatorId)
      : prepared.job;
  return { kind: "printed", job, repair };
}
