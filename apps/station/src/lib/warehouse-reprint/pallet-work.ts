import { z } from "zod";
import { loadPalletTemplates } from "./pallet-templates.js";
import { originalPalletTemplate, palletTemplateUnavailable } from "./pallet-rendering.js";
import { PalletDeliveryError, resolveOriginalPalletDelivery } from "./pallet-resolutions.js";
import { syncPalletProductionResolutions } from "./pallet-v2-sync.js";
import {
  warehouseReasonSchema,
  makePalletRenderingV2,
  palletTemplateChoiceSchema,
  type PalletTemplateChoice,
  type PalletTemplateCatalogV2,
  type PalletDeliveryDiagnostic,
  resolveWarehouseReprintScan,
  type PalletLabelSourceV1,
} from "@markiro/domain";
import type { WarehouseWorkOptions } from "./work.js";
import { resolveWarehousePalletSource } from "./pallet-sources.js";
import {
  findWarehousePalletJob,
  prepareWarehousePalletJob,
  sendWarehousePalletJob,
  recoverWarehousePalletJobs,
  settleWarehousePalletJob,
  warehousePalletJobView,
  type PalletJobView,
} from "./pallet-printing.js";
import {
  acquireCredentialCommitLease,
  credentialGenerationOwnership,
} from "../credential-recovery.js";
import { deviceRecoveryAllowsWork, readDeviceRecovery } from "../device-recovery.js";
import { stationOperatorIsCurrentlyActive } from "../offline-grants/admission.js";
import { resolvePrinter } from "../printer-routing.js";
import type { SqlExecutor } from "../mirror.js";
import type { WarehouseSession } from "./types.js";
export interface PalletWorkState {
  session: { id: string; sentCount: number; status: "active" | "finished" } | null;
  catalog: PalletTemplateCatalogV2 | null;
  choice: PalletTemplateChoice | null;
  diagnostic: PalletDeliveryDiagnostic | null;
  initialized: boolean;
  busy: boolean;
  reason: WarehouseSession["reason"];
  selection: { source: PalletLabelSourceV1; raw: string; offline: boolean } | null;
  job: PalletJobView | null;
  verification: boolean;
  error: string | null;
}
/** An independent mode; it cannot create, send or resolve unit/box attempts. */
export function createWarehousePalletWork(o: WarehouseWorkOptions) {
  let state: PalletWorkState = {
    session: null,
    catalog: null,
    choice: null,
    diagnostic: null,
    initialized: false,
    busy: false,
    reason: "damaged",
    selection: null,
    job: null,
    verification: false,
    error: null,
  };
  let owner = "",
    accepting = true,
    pending: Promise<void> | null = null,
    finished = false,
    epoch = 0;
  let finishing: Promise<boolean> | null = null;
  const subscribers = new Set<() => void>();
  const current = () => accepting && !finished && !o.generation.sealed;
  const publish = (patch: Partial<PalletWorkState>) => {
    state = { ...state, ...patch };
    for (const fn of subscribers) fn();
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
  const assertOperator = async () => {
    if (!current() || !(await deviceRecoveryAllowsWork(o.exec, o.generation)))
      throw new Error("WAREHOUSE_OWNER_CHANGED");
    if (!(await stationOperatorIsCurrentlyActive(o.exec, o.operatorId)))
      throw new Error("WAREHOUSE_OPERATOR_DENIED");
  };
  const operation = (run: () => Promise<void>) => {
    if (pending || finishing || !current()) return pending ?? Promise.resolve();
    publish({ busy: true, error: null });
    const task = Promise.resolve()
      .then(run)
      .catch((error) => {
        if (current())
          publish({
            ...(error instanceof PalletDeliveryError ? { diagnostic: error.diagnostic } : {}),
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
  const unresolved = () =>
    state.job &&
    ["prepared", "sending", "delivery_unknown", "failed_before_send"].includes(state.job.state);
  const readSession = async () => {
    const [settings] = await o.exec.all<{
      session_id: string;
      sent_count: number;
      session_status: "active" | "finished";
    }>("SELECT session_id,sent_count,session_status FROM warehouse_pallet_settings WHERE owner=?", [
      owner,
    ]);
    return settings
      ? { id: settings.session_id, sentCount: settings.sent_count, status: settings.session_status }
      : null;
  };
  const chooseFor = async (source: PalletLabelSourceV1) => {
    const [settings] = await o.exec.all<{ template_choices_json: string }>(
      "SELECT template_choices_json FROM warehouse_pallet_settings WHERE owner=?",
      [owner],
    );
    const prefs = settings
      ? z.record(z.string(), z.unknown()).parse(JSON.parse(settings.template_choices_json))
      : {};
    const prior = palletTemplateChoiceSchema.safeParse(prefs[source.rendering.kind]);
    if (
      state.catalog &&
      prior.success &&
      (prior.data.id === null ||
        state.catalog.templates.some(
          (t) => t.id === prior.data.id && t.snapshotDigest === prior.data.snapshotDigest,
        )) &&
      !palletTemplateUnavailable(source, prior.data, resolvePrinter(o.hardware(), "pallet"))
    )
      return prior.data;
    return originalPalletTemplate(source);
  };
  const send = async (jobId: string, retry = false) => {
    await assertOperator();
    const profile = resolvePrinter(o.hardware(), "pallet");
    if (!profile) throw new Error("WAREHOUSE_PRINTER_UNCONFIGURED");
    const lease = acquireCredentialCommitLease(o.generation);
    if (!lease) throw new Error("WAREHOUSE_OWNER_CHANGED");
    try {
      const recovery = await readDeviceRecovery(o.exec);
      await sendWarehousePalletJob({
        exec: o.exec,
        owner,
        operatorId: o.operatorId,
        jobId,
        profile,
        print: (target, bytes) => o.print(target, bytes),
        isCurrent: current,
        retry,
        tenantId: recovery?.owner?.tenantId ?? "",
      });
    } finally {
      lease.release();
    }
    if (current())
      publish({
        job: await warehousePalletJobView(o.exec, owner, jobId),
        selection: null,
        session: await readSession(),
      });
  };
  return {
    subscribe: (fn: () => void) => {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    getSnapshot: () => state,
    open: () => {
      if (!finished && !o.generation.sealed) accepting = true;
    },
    initialize: () =>
      operation(async () => {
        const proof = await credentialGenerationOwnership(o.generation);
        if (!proof || !current()) throw new Error("WAREHOUSE_OWNER_CHANGED");
        owner = proof;
        await recoverWarehousePalletJobs(guarded, owner, o.operatorId);
        await guarded.run(
          "INSERT INTO warehouse_pallet_settings(owner,reason,session_id,session_status) VALUES(?,'damaged',?,'active') ON CONFLICT(owner) DO UPDATE SET session_id=CASE WHEN session_status='active' AND session_id IS NOT NULL THEN session_id ELSE excluded.session_id END,sent_count=CASE WHEN session_status='active' AND session_id IS NOT NULL THEN sent_count ELSE 0 END,session_status='active'",
          [owner, crypto.randomUUID()],
        );
        const [settings] = await o.exec.all<{ reason: string }>(
          "SELECT reason FROM warehouse_pallet_settings WHERE owner=?",
          [owner],
        );
        let catalog: PalletTemplateCatalogV2 | null = null;
        try {
          catalog = await loadPalletTemplates(o.client, guarded, owner);
        } catch {
          /* Original snapshots remain usable without a refreshed catalog. */
        }
        if (!current()) return;
        publish({
          initialized: true,
          session: await readSession(),
          catalog,
          job: await findWarehousePalletJob(o.exec, owner),
          reason: settings ? warehouseReasonSchema.parse(settings.reason) : "damaged",
        });
      }),
    refreshTemplates: () =>
      operation(async () => {
        await assertOperator();
        const catalog = await loadPalletTemplates(o.client, guarded, owner);
        if (current()) publish({ catalog });
      }),
    selectTemplate: (input: PalletTemplateChoice) =>
      operation(async () => {
        if (unresolved()) throw new Error("WAREHOUSE_RECOVERY_REQUIRED");
        await assertOperator();
        const source = state.selection?.source;
        if (!source) throw new Error("WAREHOUSE_PALLET_SOURCE_CHANGED");
        const choice = palletTemplateChoiceSchema.parse(input);
        if (
          choice.id !== null &&
          !state.catalog?.templates.some(
            (t) => t.id === choice.id && t.snapshotDigest === choice.snapshotDigest,
          )
        )
          throw new Error("WAREHOUSE_CATALOG_NETWORK");
        const unavailable = palletTemplateUnavailable(
          source,
          choice,
          resolvePrinter(o.hardware(), "pallet"),
        );
        if (unavailable) throw new Error(unavailable);
        await guarded.run(
          "UPDATE warehouse_pallet_settings SET template_choices_json=json_set(template_choices_json,?,json(?)) WHERE owner=?",
          ["$." + choice.kind, JSON.stringify(choice), owner],
        );
        if (current()) publish({ choice });
      }),
    resolveOriginal: (
      outcome: "confirmed" | "skipped",
      scannedSscc?: string,
      reason: WarehouseSession["reason"] = "not_printed",
    ) =>
      operation(async () => {
        await assertOperator();
        const diagnostic = state.diagnostic;
        if (!diagnostic) throw new Error("WAREHOUSE_PALLET_SOURCE_CHANGED");
        await resolveOriginalPalletDelivery({
          exec: guarded,
          owner,
          generation: o.generation,
          deviceId: o.deviceId,
          operatorId: o.operatorId,
          diagnostic,
          outcome,
          reason,
          ...(scannedSscc !== undefined ? { scannedSscc } : {}),
        });
        try {
          await syncPalletProductionResolutions(guarded, o.client, owner, current);
        } catch {
          /* Durable decision awaits reconnect. */
        }
        if (current()) publish({ diagnostic: null, error: null, selection: null });
      }),
    refreshOriginal: () =>
      operation(async () => {
        const diagnostic = state.diagnostic;
        if (!diagnostic) return;
        await assertOperator();
        const found = await resolveWarehousePalletSource(
          o.client,
          guarded,
          owner,
          diagnostic.sscc,
          o.operatorId,
        );
        if (current())
          publish({
            selection: { ...found, raw: diagnostic.sscc },
            diagnostic: null,
            choice: await chooseFor(found.source),
            job: null,
          });
      }),
    setReason: (reason: WarehouseSession["reason"]) =>
      operation(async () => {
        if (unresolved()) throw new Error("WAREHOUSE_RECOVERY_REQUIRED");
        await assertOperator();
        const value = warehouseReasonSchema.parse(reason);
        await guarded.run(
          "INSERT INTO warehouse_pallet_settings(owner,reason) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET reason=excluded.reason",
          [owner, value],
        );
        publish({ reason: value });
      }),
    scan: (raw: string) =>
      operation(async () => {
        await assertOperator();
        if (state.verification && state.job) {
          const scan = resolveWarehouseReprintScan(raw);
          if (scan.kind !== "box" || scan.repair !== null || scan.sscc !== state.job.source.sscc)
            throw new Error("WAREHOUSE_VERIFY_MISMATCH");
          await settleWarehousePalletJob(guarded, owner, state.job.jobId, o.operatorId, "verified");
          publish({
            verification: false,
            job: await warehousePalletJobView(o.exec, owner, state.job.jobId),
          });
          return;
        }
        if (unresolved()) throw new Error("WAREHOUSE_RECOVERY_REQUIRED");
        publish({
          selection: null,
          job: null,
          choice: null,
          diagnostic: null,
          verification: false,
        });
        const stamp = epoch;
        const found = await resolveWarehousePalletSource(
          o.client,
          guarded,
          owner,
          raw,
          o.operatorId,
        );
        if (!current() || stamp !== epoch) throw new Error("WAREHOUSE_OWNER_CHANGED");
        publish({
          selection: { ...found, raw },
          verification: false,
          diagnostic: null,
          choice: await chooseFor(found.source),
          job: null,
        });
      }),
    cancel: () => {
      if (!pending && current() && !unresolved()) {
        ++epoch;
        publish({
          selection: null,
          verification: false,
          error: null,
          diagnostic: null,
          choice: null,
        });
      }
    },
    confirm: (revision: string) =>
      operation(async () => {
        if (unresolved()) throw new Error("WAREHOUSE_RECOVERY_REQUIRED");
        const selected = state.selection;
        if (!selected || selected.source.revision !== revision)
          throw new Error("WAREHOUSE_PALLET_SOURCE_CHANGED");
        await assertOperator();
        const found = await resolveWarehousePalletSource(
          o.client,
          guarded,
          owner,
          selected.raw,
          o.operatorId,
        );
        if (
          !current() ||
          found.source.revision !== revision ||
          found.source.sscc !== selected.source.sscc
        )
          throw new Error("WAREHOUSE_PALLET_SOURCE_CHANGED");
        const choice = state.choice ?? originalPalletTemplate(found.source);
        if (choice.id !== null && !state.catalog) throw new Error("WAREHOUSE_CATALOG_NETWORK");
        const profile = resolvePrinter(o.hardware(), "pallet");
        const unavailable = palletTemplateUnavailable(found.source, choice, profile);
        if (unavailable) throw new Error(unavailable);
        if (!profile) throw new Error("WAREHOUSE_PRINTER_UNCONFIGURED");
        const lease = acquireCredentialCommitLease(o.generation);
        if (!lease) throw new Error("WAREHOUSE_OWNER_CHANGED");
        try {
          const recovery = await readDeviceRecovery(o.exec);
          const preparing: SqlExecutor = {
            all: (sql, params) => guarded.all(sql, params),
            run: async (sql, params) => {
              if (
                JSON.stringify(resolvePrinter(o.hardware(), "pallet")) !== JSON.stringify(profile)
              )
                throw new Error("WAREHOUSE_PRINTER_CHANGED");
              await guarded.run(sql, params);
            },
          };
          const job = await prepareWarehousePalletJob({
            exec: preparing,
            owner,
            operatorId: o.operatorId,
            reason: state.reason,
            source: found.source,
            ...(state.catalog ? { rendering: makePalletRenderingV2(found.source, choice) } : {}),
            ...(state.session ? { sessionId: state.session.id } : {}),
            profile,
            tenantId: recovery?.owner?.tenantId ?? "",
          });
          publish({ job, selection: null });
          await assertOperator();
          await send(job.jobId);
        } finally {
          lease.release();
        }
      }),
    retry: () =>
      operation(async () => {
        const job = state.job;
        if (!job) return;
        await assertOperator();
        const found = await resolveWarehousePalletSource(
          o.client,
          guarded,
          owner,
          job.source.sscc,
          o.operatorId,
        );
        if (found.source.revision !== job.source.revision)
          throw new Error("WAREHOUSE_PALLET_SOURCE_CHANGED");
        await send(job.jobId, true);
      }),
    verify: () => {
      if (
        current() &&
        !pending &&
        state.job &&
        ["sent", "delivery_unknown"].includes(state.job.state)
      )
        publish({ verification: true, error: null });
    },
    cancelVerification: () => {
      if (!pending) publish({ verification: false });
    },
    skip: () =>
      operation(async () => {
        if (!state.job) return;
        await assertOperator();
        await settleWarehousePalletJob(guarded, owner, state.job.jobId, o.operatorId, "skipped");
        publish({
          job: await warehousePalletJobView(o.exec, owner, state.job.jobId),
          verification: false,
          selection: null,
        });
      }),
    finish: () => {
      if (finishing) return finishing;
      const task = (async () => {
        await pending;
        if (!current() || !owner) return false;
        await assertOperator();
        if (await findWarehousePalletJob(o.exec, owner)) {
          publish({ error: "WAREHOUSE_RECOVERY_REQUIRED" });
          return false;
        }
        await guarded.run(
          "UPDATE warehouse_pallet_settings SET session_status='finished' WHERE owner=?",
          [owner],
        );
        publish({ session: await readSession() });
        finished = true;
        accepting = false;
        return true;
      })().finally(() => {
        if (finishing === task) finishing = null;
      });
      finishing = task;
      return task;
    },
    close: async () => {
      accepting = false;
      ++epoch;
      await pending;
      await finishing;
    },
    idle: async () => {
      await pending;
      await finishing;
    },
    poll: async () => {
      if (!current() || !owner || pending || finishing) return;
      await recoverWarehousePalletJobs(guarded, owner, o.operatorId);
      const job = await findWarehousePalletJob(o.exec, owner);
      if (job) publish({ job });
    },
  };
}
