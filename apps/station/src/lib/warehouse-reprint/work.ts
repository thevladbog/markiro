import {
  productLabelBytesDigest,
  resolveWarehouseReprintScan,
  type WarehouseTemplateCatalog,
  type WarehouseTemplate,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import type { StationClient } from "../api-client.js";
import {
  acquireCredentialCommitLease,
  credentialGenerationOwnership,
  type CredentialGeneration,
} from "../credential-recovery.js";
import { AUTHORIZED_CREDENTIAL_OWNERS_SQL, deviceRecoveryAllowsWork } from "../device-recovery.js";
import { resolvePrinter } from "../printer-routing.js";
import type { HardwareConfig } from "../hardware-config.js";
import type { PrintTarget } from "../hardware.js";
import { rasterizeText } from "../rasterizer.js";
import { resolveWarehouseSource } from "./sources.js";
import {
  loadWarehouseBoxDefault,
  loadWarehouseTemplates,
  refreshWarehouseTemplates,
  resolveWarehouseTemplateSelection,
} from "./templates.js";
import { renderWarehouseLabel } from "./prepare.js";
import {
  findWarehouseJobView,
  finishWarehouseSession,
  prepareWarehouseJob,
  readWarehouseJob,
  readWarehouseTemplatePreference,
  resumeWarehouseSession,
  saveWarehouseSession,
} from "./store.js";
import {
  printWarehouseJob,
  recoverWarehouseJobs,
  reprintWarehouseJob,
  verifyWarehouseJob,
} from "./printing.js";
import type { WarehouseSession, WarehouseJobView } from "./types.js";
export interface WarehouseWorkState {
  initialized: boolean;
  busy: boolean;
  session: WarehouseSession | null;
  catalog: WarehouseTemplateCatalog | null;
  defaultBoxId: string | null;
  job: WarehouseJobView | null;
  duplicate: boolean;
  error: string | null;
  verification: boolean;
  historyIssue: string | null;
}
export interface WarehouseWorkOptions {
  exec: SqlExecutor;
  client: StationClient;
  generation: CredentialGeneration;
  deviceId: string;
  operatorId: string;
  hardware(): HardwareConfig;
  print(target: PrintTarget, bytes: Uint8Array): Promise<void>;
  onJournalChange?: () => void;
}
export function createWarehouseWork(o: WarehouseWorkOptions) {
  let state: WarehouseWorkState = {
    initialized: false,
    busy: false,
    session: null,
    catalog: null,
    defaultBoxId: null,
    job: null,
    duplicate: false,
    error: null,
    verification: false,
    historyIssue: null,
  };
  let accepting = true;
  let pending: Promise<void> | null = null;
  let finishing: Promise<boolean> | null = null;
  let finished = false;
  let owner = "";
  let refreshVersion = 0;
  let historyProblem: {
    owner: string;
    event_id: string;
    digest: string;
    rejection_code: string;
  } | null = null;
  const subscribers = new Set<() => void>();
  const current = () => accepting && !finished && !o.generation.sealed;
  const publish = (patch: Partial<WarehouseWorkState>) => {
    state = { ...state, ...patch };
    for (const notify of subscribers) notify();
  };
  const guarded: SqlExecutor = {
    all: o.exec.all.bind(o.exec),
    run: async (sql, params) => {
      if (!current()) throw new Error("WAREHOUSE_OWNER_CHANGED");
      const lease = acquireCredentialCommitLease(o.generation);
      if (!lease) throw new Error("WAREHOUSE_OWNER_CHANGED");
      try {
        await o.exec.run(sql, params);
      } finally {
        lease.release();
      }
    },
  };
  const refresh = async (jobId?: string) => {
    const version = ++refreshVersion;
    const session = await resumeWarehouseSession(o.exec, owner);
    const job = await findWarehouseJobView(
      o.exec,
      owner,
      jobId ? { jobId } : session ? { sessionId: session.sessionId } : {},
    );
    const [problem] = await o.exec.all<NonNullable<typeof historyProblem>>(
      `SELECT e.owner,e.event_id,e.digest,e.rejection_code FROM warehouse_reprint_events e
       WHERE e.owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND e.receive_status='quarantined'
       AND NOT EXISTS(SELECT 1 FROM warehouse_reprint_history_acknowledgements a
         WHERE a.owner=e.owner AND a.event_id=e.event_id AND a.digest=e.digest AND a.rejection_code=e.rejection_code)
       ORDER BY e.rowid DESC LIMIT 1`,
      [owner],
    );
    if (version !== refreshVersion) return;
    historyProblem = problem ?? null;
    publish({
      session,
      job,
      historyIssue: problem?.rejection_code ?? null,
    });
  };
  const operation = (run: () => Promise<void>) => {
    if (finishing || pending || !current()) return pending ?? Promise.resolve();
    publish({ busy: true, error: null });
    const task = run()
      .catch((error) => {
        if (current())
          publish({
            error:
              error instanceof Error && error.message.startsWith("WAREHOUSE_")
                ? error.message
                : "WAREHOUSE_OPERATION_FAILED",
          });
      })
      .finally(() => {
        if (pending === task) pending = null;
        publish({ busy: finishing !== null });
        o.onJournalChange?.();
      });
    pending = task;
    return task;
  };
  const assertOperator = async () => {
    const [operator] = await o.exec.all<{ operator_id: string }>(
      "SELECT operator_id FROM operators_mirror WHERE operator_id=? AND active=1",
      [o.operatorId],
    );
    if (!operator) throw new Error("WAREHOUSE_OPERATOR_DENIED");
  };
  const refreshTemplateCatalog = async (freshSession = false) => {
    const catalog = await loadWarehouseTemplates(o.client, guarded, owner);
    const defaultBoxId = await loadWarehouseBoxDefault(o.client, guarded, owner);
    if (!current()) throw new Error("WAREHOUSE_OWNER_CHANGED");
    const session = state.session;
    if (session) {
      const autoSelectUnit =
        freshSession || (session.unitTemplate === null && !session.unitTemplateNeedsSelection);
      const autoSelectBox =
        freshSession || (session.boxTemplate === null && !session.boxTemplateNeedsSelection);
      const unitTemplate = resolveWarehouseTemplateSelection(
        catalog,
        "unit",
        session.unitTemplate?.id ?? null,
        defaultBoxId,
      );
      const boxTemplate =
        (freshSession
          ? resolveWarehouseTemplateSelection(catalog, "box", null, defaultBoxId)
          : null) ??
        resolveWarehouseTemplateSelection(
          catalog,
          "box",
          session.boxTemplate?.id ?? null,
          defaultBoxId,
        );
      await saveWarehouseSession(guarded, {
        ...session,
        // Fill initial empty choices when the catalog becomes available, but
        // persist invalidation so refresh/Cancel/restart never substitutes a choice.
        unitTemplate:
          autoSelectUnit || unitTemplate?.id === session.unitTemplate?.id ? unitTemplate : null,
        boxTemplate:
          autoSelectBox || boxTemplate?.id === session.boxTemplate?.id ? boxTemplate : null,
        unitTemplateNeedsSelection:
          !autoSelectUnit &&
          (session.unitTemplateNeedsSelection === true ||
            unitTemplate?.id !== session.unitTemplate?.id),
        boxTemplateNeedsSelection:
          !autoSelectBox &&
          (session.boxTemplateNeedsSelection === true ||
            boxTemplate?.id !== session.boxTemplate?.id),
      });
    }
    if (!current()) throw new Error("WAREHOUSE_OWNER_CHANGED");
    publish({ catalog, defaultBoxId });
    await refresh(state.job?.jobId);
  };
  const printing = async (jobId: string, reprint?: WarehouseSession["reason"]) => {
    if (!current() || !(await deviceRecoveryAllowsWork(o.exec, o.generation)))
      throw new Error("WAREHOUSE_OWNER_CHANGED");
    await assertOperator();
    const job = await readWarehouseJob(o.exec, owner, jobId);
    const profile = resolvePrinter(o.hardware(), job.source.kind === "box" ? "box" : "duplicate");
    const lease = acquireCredentialCommitLease(o.generation);
    if (!lease) throw new Error("WAREHOUSE_OWNER_CHANGED");
    try {
      const deps = {
        exec: o.exec,
        owner,
        operatorId: o.operatorId,
        profile,
        print: (target: PrintTarget, bytes: Uint8Array) => o.print(target, bytes),
        isCurrent: current,
      };
      if (reprint) await reprintWarehouseJob(deps, jobId, reprint);
      else await printWarehouseJob(deps, jobId);
    } finally {
      lease.release();
    }
    await refresh(jobId);
  };
  return {
    subscribe: (fn: () => void) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    getSnapshot: () => state,
    refreshCatalog: () => operation(refreshTemplateCatalog),
    acknowledgeHistory: () =>
      operation(async () => {
        const problem = historyProblem;
        if (!problem) return;
        await assertOperator();
        if (!(await deviceRecoveryAllowsWork(o.exec, o.generation)))
          throw new Error("WAREHOUSE_OWNER_CHANGED");
        await guarded.run(
          `INSERT INTO warehouse_reprint_history_acknowledgements(owner,event_id,digest,rejection_code,operator_id,acknowledged_at)
           SELECT owner,event_id,digest,rejection_code,?,? FROM warehouse_reprint_events
           WHERE owner=? AND event_id=? AND digest=? AND rejection_code=? AND receive_status='quarantined'
           ON CONFLICT(owner,event_id) DO UPDATE SET digest=excluded.digest,rejection_code=excluded.rejection_code,
             operator_id=excluded.operator_id,acknowledged_at=excluded.acknowledged_at`,
          [
            o.operatorId,
            new Date().toISOString(),
            problem.owner,
            problem.event_id,
            problem.digest,
            problem.rejection_code,
          ],
        );
        await refresh();
      }),
    // Effect setup can reopen this same controller after StrictMode's simulated cleanup.
    open: () => {
      if (!finished && !o.generation.sealed) accepting = true;
    },
    initialize: () =>
      operation(async () => {
        const proof = await credentialGenerationOwnership(o.generation);
        if (!proof || !current() || !(await deviceRecoveryAllowsWork(o.exec, o.generation)))
          throw new Error("WAREHOUSE_OWNER_CHANGED");
        owner = proof;
        let session = await resumeWarehouseSession(o.exec, owner);
        const freshSession = session === null;
        const preference = freshSession
          ? await readWarehouseTemplatePreference(o.exec, owner)
          : null;
        session = session
          ? { ...session, operatorId: o.operatorId, status: "paused" }
          : {
              owner,
              sessionId: crypto.randomUUID(),
              operatorId: o.operatorId,
              reason: "damaged",
              status: "paused",
              unitTemplate: preference?.unitTemplate ?? null,
              boxTemplate: preference?.boxTemplate ?? null,
              sentCount: 0,
            };
        await saveWarehouseSession(guarded, session);
        await recoverWarehouseJobs(guarded, owner, o.operatorId);
        await refresh();
        try {
          await refreshTemplateCatalog(freshSession);
        } catch (error) {
          if (current())
            publish({
              error:
                error instanceof Error && error.message.startsWith("WAREHOUSE_")
                  ? error.message
                  : "WAREHOUSE_CATALOG_NETWORK",
            });
        }
        if (current()) publish({ initialized: true });
      }),
    configure: (
      reason: WarehouseSession["reason"],
      unitTemplate: WarehouseTemplate | null,
      boxTemplate: WarehouseTemplate | null,
    ) =>
      operation(async () => {
        if (
          !state.session ||
          (state.job && ["prepared", "sending", "delivery_unknown"].includes(state.job.state))
        )
          throw new Error("WAREHOUSE_BUSY");
        if (
          unitTemplate &&
          (!unitTemplate.enabled ||
            unitTemplate.purpose !== "product_duplicate" ||
            !state.catalog?.templates.some(
              (t) =>
                t.enabled &&
                t.purpose === "product_duplicate" &&
                t.id === unitTemplate.id &&
                t.digest === unitTemplate.digest,
            ))
        )
          throw new Error("WAREHOUSE_TEMPLATE_PURPOSE");
        if (
          boxTemplate &&
          (!boxTemplate.enabled ||
            boxTemplate.purpose !== "box" ||
            !state.catalog?.templates.some(
              (t) =>
                t.enabled &&
                t.purpose === "box" &&
                t.id === boxTemplate.id &&
                t.digest === boxTemplate.digest,
            ))
        )
          throw new Error("WAREHOUSE_TEMPLATE_PURPOSE");
        await saveWarehouseSession(guarded, {
          ...state.session,
          reason,
          unitTemplate,
          boxTemplate,
          unitTemplateNeedsSelection:
            unitTemplate === null &&
            (state.session.unitTemplate !== null ||
              state.session.unitTemplateNeedsSelection === true),
          boxTemplateNeedsSelection:
            boxTemplate === null &&
            (state.session.boxTemplate !== null ||
              state.session.boxTemplateNeedsSelection === true),
        });
        await refresh();
      }),
    start: () =>
      operation(async () => {
        if (!state.session) throw new Error("WAREHOUSE_TEMPLATES_REQUIRED");
        const recovering =
          state.job &&
          ["prepared", "sending", "delivery_unknown", "failed_before_send"].includes(
            state.job.state,
          );
        if (
          !recovering &&
          (!state.session.unitTemplate ||
            !state.session.boxTemplate ||
            !state.catalog?.templates.some(
              (t) =>
                t.id === state.session?.unitTemplate?.id &&
                t.digest === state.session.unitTemplate.digest &&
                t.purpose === "product_duplicate" &&
                t.enabled,
            ) ||
            !state.catalog.templates.some(
              (t) =>
                t.id === state.session?.boxTemplate?.id &&
                t.digest === state.session.boxTemplate.digest &&
                t.purpose === "box" &&
                t.enabled,
            ))
        )
          throw new Error("WAREHOUSE_TEMPLATES_REQUIRED");
        if (!(await deviceRecoveryAllowsWork(o.exec, o.generation)))
          throw new Error("WAREHOUSE_OWNER_CHANGED");
        await saveWarehouseSession(guarded, { ...state.session, status: "active" });
        await refresh();
      }),
    scan: (raw: string) =>
      operation(async () => {
        const session = state.session;
        if (!session || session.status !== "active") return;
        await assertOperator();
        if (state.verification && state.job) {
          const match = await verifyWarehouseJob(
            guarded,
            owner,
            state.job.jobId,
            o.operatorId,
            raw,
          );
          if (!match) throw new Error("WAREHOUSE_VERIFY_MISMATCH");
          publish({ verification: false, duplicate: false });
          await refresh(state.job.jobId);
          return;
        }
        if (
          state.job &&
          ["prepared", "sending", "delivery_unknown", "failed_before_send"].includes(
            state.job.state,
          )
        )
          throw new Error("WAREHOUSE_RECOVERY_REQUIRED");
        publish({ duplicate: false });
        const scan = resolveWarehouseReprintScan(raw);
        if (scan.kind === "invalid") throw new Error("WAREHOUSE_SCAN_INVALID");
        const identity = scan.kind === "box" ? scan.sscc : scan.codeHash;
        const existing = await findWarehouseJobView(o.exec, owner, {
          sessionId: session.sessionId,
          kind: scan.kind,
          identity,
        });
        if (existing) {
          publish({ duplicate: true, job: existing });
          return;
        }
        const found = await resolveWarehouseSource(o.client, guarded, owner, raw, o.operatorId);
        if (found.status !== "found")
          throw new Error(
            found.status === "unavailable"
              ? `WAREHOUSE_${found.code.toUpperCase()}`
              : `WAREHOUSE_${found.status.toUpperCase()}`,
          );
        const selected = found.source.kind === "box" ? session.boxTemplate : session.unitTemplate;
        if (!selected || !state.catalog) throw new Error("WAREHOUSE_TEMPLATES_REQUIRED");
        const catalog = await refreshWarehouseTemplates(o.client, guarded, owner, state.catalog, [
          selected.id,
        ]);
        if (!current()) throw new Error("WAREHOUSE_OWNER_CHANGED");
        const template = catalog.templates.find((t) => t.id === selected.id && t.enabled) ?? null;
        await saveWarehouseSession(guarded, {
          ...session,
          ...(found.source.kind === "box"
            ? { boxTemplate: template, boxTemplateNeedsSelection: template === null }
            : { unitTemplate: template, unitTemplateNeedsSelection: template === null }),
        });
        publish({ catalog });
        await refresh();
        if (!template) throw new Error("WAREHOUSE_TEMPLATE_UNAVAILABLE");
        const profile = resolvePrinter(
          o.hardware(),
          found.source.kind === "box" ? "box" : "duplicate",
        );
        if (!profile) throw new Error("WAREHOUSE_PRINTER_UNCONFIGURED");
        const rendered = await renderWarehouseLabel(found.source, template, profile, rasterizeText);
        if (
          !current() ||
          state.session?.sessionId !== session.sessionId ||
          state.session.status !== "active"
        )
          throw new Error("WAREHOUSE_OWNER_CHANGED");
        const jobId = crypto.randomUUID();
        const event = {
          kind: "prepared" as const,
          eventId: crypto.randomUUID(),
          jobId,
          sessionId: session.sessionId,
          attemptId: crypto.randomUUID(),
          operatorId: o.operatorId,
          sequence: 1,
          occurredAt: new Date().toISOString(),
          attemptNo: 1 as const,
          reason: session.reason,
          sourceKind: found.source.kind,
          sourceId: found.source.sourceId,
          identity: found.source.identity,
          sourceRevision: found.source.revision,
          sourceShiftId: found.source.sourceShiftId,
          templateId: template.id,
          templateRevision: template.revision,
          templateDigest: template.digest,
          payloadDigest: found.source.payloadDigest,
          bytesDigest: rendered.bytesDigest,
          scanDigest: productLabelBytesDigest(new TextEncoder().encode(raw)),
          repair: found.repair,
          language: profile.language,
          dpi: profile.dpi,
        };
        if (event.dpi === null) throw new Error("WAREHOUSE_PRINTER_DPI");
        await assertOperator();
        const result = await prepareWarehouseJob(guarded, {
          owner: session.owner,
          sessionId: session.sessionId,
          jobId,
          deviceId: o.deviceId,
          operatorId: o.operatorId,
          reason: session.reason,
          source: found.source,
          template,
          printer: profile,
          ...rendered,
          preparedEvent: { ...event, dpi: event.dpi },
        });
        if (result !== "prepared")
          throw new Error(result === "duplicate" ? "WAREHOUSE_DUPLICATE" : "WAREHOUSE_BUSY");
        await refresh(jobId);
        await printing(jobId);
      }),
    newSession: () =>
      operation(async () => {
        if (!state.session) throw new Error("WAREHOUSE_OPERATION_FAILED");
        if (await findWarehouseJobView(o.exec, owner, { unresolvedOnly: true }))
          throw new Error("WAREHOUSE_RECOVERY_REQUIRED");
        await saveWarehouseSession(guarded, { ...state.session, status: "paused" });
        await saveWarehouseSession(guarded, {
          ...state.session,
          sessionId: crypto.randomUUID(),
          status: "paused",
          sentCount: 0,
          unitTemplateNeedsSelection: false,
          boxTemplateNeedsSelection: false,
          boxTemplate:
            (state.catalog
              ? resolveWarehouseTemplateSelection(state.catalog, "box", null, state.defaultBoxId)
              : null) ?? state.session.boxTemplate,
        });
        publish({ duplicate: false, verification: false, job: null });
        await refresh();
      }),
    requestVerification: () => {
      if (
        !pending &&
        current() &&
        state.job &&
        ["sent", "delivery_unknown"].includes(state.job.state)
      )
        publish({ verification: true, error: null });
    },
    cancelVerification: () => {
      if (!pending) publish({ verification: false });
    },
    reprint: (reason: WarehouseSession["reason"]) =>
      operation(async () => {
        if (state.job) await printing(state.job.jobId, reason);
      }),
    sendPrepared: () =>
      operation(async () => {
        if (state.job) await printing(state.job.jobId);
      }),
    /** Stops new intake, drains accepted work, and returns true only after durable closure. */
    finish: (): Promise<boolean> => {
      if (finished) return Promise.resolve(true);
      if (finishing) return finishing;
      if (!current() || !owner || !state.session) return Promise.resolve(false);
      const task = Promise.resolve()
        .then(async () => {
          await pending;
          const session = state.session;
          if (!current() || !session) throw new Error("WAREHOUSE_OWNER_CHANGED");
          await assertOperator();
          if (!(await deviceRecoveryAllowsWork(o.exec, o.generation)))
            throw new Error("WAREHOUSE_OWNER_CHANGED");
          const committed = await finishWarehouseSession(
            guarded,
            owner,
            session.sessionId,
            o.operatorId,
          );
          if (!committed) throw new Error("WAREHOUSE_OWNER_CHANGED");
          finished = true;
          accepting = false;
          ++refreshVersion;
          publish({ session: null, job: null, duplicate: false, verification: false });
          return true;
        })
        .catch((error: unknown) => {
          if (current())
            publish({
              error:
                error instanceof Error && error.message.startsWith("WAREHOUSE_")
                  ? error.message
                  : "WAREHOUSE_OPERATION_FAILED",
            });
          return false;
        })
        .finally(() => {
          if (finishing === task) finishing = null;
          publish({ busy: false });
          o.onJournalChange?.();
        });
      finishing = task;
      publish({ busy: true, error: null });
      return task;
    },
    close: async () => {
      accepting = false;
      await pending;
      await finishing;
      if (!finished && !accepting && owner && state.session) {
        const lease = acquireCredentialCommitLease(o.generation);
        if (lease) {
          try {
            await saveWarehouseSession(o.exec, { ...state.session, status: "paused" });
          } finally {
            lease.release();
          }
        }
      }
    },
    idle: async () => {
      await pending;
      await finishing;
    },
    poll: async () => {
      if (current() && owner && !pending && !finishing) await refresh(state.job?.jobId);
    },
  };
}
