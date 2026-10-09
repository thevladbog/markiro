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
import { loadWarehouseTemplates } from "./templates.js";
import { renderWarehouseLabel } from "./prepare.js";
import {
  findWarehouseJobView,
  prepareWarehouseJob,
  readWarehouseJob,
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
    job: null,
    duplicate: false,
    error: null,
    verification: false,
    historyIssue: null,
  };
  let accepting = true;
  let pending: Promise<void> | null = null;
  let owner = "";
  const subscribers = new Set<() => void>();
  const current = () => accepting && !o.generation.sealed;
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
    const session = await resumeWarehouseSession(o.exec, owner);
    const job = await findWarehouseJobView(
      o.exec,
      owner,
      jobId ? { jobId } : session ? { sessionId: session.sessionId } : {},
    );
    const [problem] = await o.exec.all<{ rejection_code: string }>(
      `SELECT rejection_code FROM warehouse_reprint_events WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND receive_status='quarantined' ORDER BY rowid DESC LIMIT 1`,
      [owner],
    );
    publish({
      session,
      job,
      historyIssue: problem?.rejection_code ?? null,
    });
  };
  const operation = (run: () => Promise<void>) => {
    if (pending || !current()) return pending ?? Promise.resolve();
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
        publish({ busy: false });
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
    // Effect setup can reopen this same controller after StrictMode's simulated cleanup.
    open: () => {
      if (!o.generation.sealed) accepting = true;
    },
    initialize: () =>
      operation(async () => {
        const proof = await credentialGenerationOwnership(o.generation);
        if (!proof || !current() || !(await deviceRecoveryAllowsWork(o.exec, o.generation)))
          throw new Error("WAREHOUSE_OWNER_CHANGED");
        owner = proof;
        let session = await resumeWarehouseSession(o.exec, owner);
        session = session
          ? { ...session, operatorId: o.operatorId, status: "paused" }
          : {
              owner,
              sessionId: crypto.randomUUID(),
              operatorId: o.operatorId,
              reason: "damaged",
              status: "paused",
              unitTemplate: null,
              boxTemplate: null,
              sentCount: 0,
            };
        await saveWarehouseSession(guarded, session);
        await recoverWarehouseJobs(guarded, owner, o.operatorId);
        await refresh();
        try {
          const catalog = await loadWarehouseTemplates(o.client, guarded, owner);
          if (current()) publish({ catalog });
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
          (unitTemplate.purpose !== "product_duplicate" ||
            !state.catalog?.templates.some(
              (t) => t.id === unitTemplate.id && t.digest === unitTemplate.digest,
            ))
        )
          throw new Error("WAREHOUSE_TEMPLATE_PURPOSE");
        if (
          boxTemplate &&
          (boxTemplate.purpose !== "box" ||
            !state.catalog?.templates.some(
              (t) => t.id === boxTemplate.id && t.digest === boxTemplate.digest,
            ))
        )
          throw new Error("WAREHOUSE_TEMPLATE_PURPOSE");
        await saveWarehouseSession(guarded, {
          ...state.session,
          reason,
          unitTemplate,
          boxTemplate,
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
                t.enabled,
            ) ||
            !state.catalog.templates.some(
              (t) =>
                t.id === state.session?.boxTemplate?.id &&
                t.digest === state.session.boxTemplate.digest &&
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
        const template = found.source.kind === "box" ? session.boxTemplate : session.unitTemplate;
        if (!template) throw new Error("WAREHOUSE_TEMPLATES_REQUIRED");
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
    close: async () => {
      accepting = false;
      await pending;
      if (!accepting && owner && state.session) {
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
    },
    poll: async () => {
      if (current() && owner && !pending) await refresh(state.job?.jobId);
    },
  };
}
