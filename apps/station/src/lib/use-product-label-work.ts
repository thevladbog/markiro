import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DomainError, productLabelValueDigest, type ReprintReason } from "@markiro/domain";
import type { SqlExecutor } from "./mirror.js";
import {
  acquireCredentialCommitLease,
  credentialGenerationIsCurrent,
  credentialGenerationOwnership,
  type CredentialGeneration,
  type FloorWorkBarrier,
} from "./credential-recovery.js";
import { recordProductLabelAcceptance } from "./product-labels/acceptance.js";
import { readDuplicateLabelContext } from "./product-labels/context.js";
import { prepareProductLabelAcceptance } from "./product-labels/fields.js";
import {
  prepareProductLabelReprint,
  sendPreparedProductLabel,
  verifyProductLabel,
} from "./product-labels/printing.js";
import { restoreProductLabelWork } from "./product-labels/recovery.js";
import {
  listProductLabelJobViews,
  presentProductLabelJob,
  requireProductLabelJob,
} from "./product-labels/store.js";
import type {
  PreparedProductLabelAcceptance,
  ProductLabelAcceptResult,
  ProductLabelJobView,
  ProductLabelPrintingDeps,
} from "./product-labels/types.js";
import type { HardwareConfig } from "./hardware-config.js";
import type { PrintTarget } from "./hardware.js";
import { rasterizeText } from "./rasterizer.js";

export interface ProductLabelWorkState {
  ready: boolean;
  busy: boolean;
  job: ProductLabelJobView | null;
  error: "storage" | "another_shift" | "printer" | null;
  closed: boolean;
  result: "match" | "mismatch" | "invalid" | null;
}
interface ProductLabelWorkOptions {
  exec: SqlExecutor;
  shiftId: string;
  credentialOwnership: string;
  generation?: CredentialGeneration;
  getPrinting(): ProductLabelPrintingDeps;
  canPrint?(): boolean;
  isCurrent?(): boolean;
  prepare(raw: string): Promise<PreparedProductLabelAcceptance>;
}

/** One admission latch covers preparation, durable events, transport and verification. */
export function createProductLabelWork(options: ProductLabelWorkOptions) {
  const { exec, credentialOwnership, shiftId, generation } = options;
  let state: ProductLabelWorkState = {
    ready: false,
    busy: false,
    job: null,
    error: null,
    closed: false,
    result: null,
  };
  const listeners = new Set<() => void>();
  let accepting = true;
  let pending: Promise<unknown> | null = null;
  let initialized = false;
  let verificationPaused = false;
  const current = () =>
    accepting &&
    options.isCurrent?.() !== false &&
    (!generation || credentialGenerationIsCurrent(generation));
  function publish(patch: Partial<ProductLabelWorkState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  function run<T>(operation: () => Promise<T>): Promise<T> {
    if (!current() || pending)
      return Promise.reject(new DomainError("PRODUCT_LABEL_BUSY", "Label work is unavailable"));
    const lease = generation ? acquireCredentialCommitLease(generation) : null;
    if (generation && !lease)
      return Promise.reject(new DomainError("PRODUCT_LABEL_STALE", "Credential is retired"));
    publish({ busy: true, result: null });
    const result = Promise.resolve().then(operation);
    const tracked = result.finally(() => {
      lease?.release();
      if (pending === tracked) pending = null;
      publish({ busy: false });
    });
    pending = tracked;
    return tracked;
  }
  async function refresh(jobId?: string) {
    const [shift] = await exec.all<{ status: string }>(
      "SELECT status FROM shift_mirror WHERE id=?",
      [shiftId],
    );
    const job = jobId
      ? presentProductLabelJob(await requireProductLabelJob(exec, credentialOwnership, jobId))
      : await restoreProductLabelWork(exec, credentialOwnership, options.getPrinting());
    if (job && job.shiftId !== shiftId) {
      publish({ job: null, closed: true, error: "another_shift" });
      return;
    }
    publish({
      job,
      closed: shift?.status !== "active",
      error:
        (!job || job.status === "completed") && options.canPrint?.() === false ? "printer" : null,
    });
  }
  async function send(jobId: string) {
    try {
      if (!current()) return;
      const job = await sendPreparedProductLabel(
        { ...options.getPrinting(), recovery: state.closed },
        jobId,
      );
      publish({ job });
    } catch {
      // A saved acceptance stays accepted even if the transport result cannot be committed.
      // Recovery changes durable sending to unknown; it never repeats the transport.
      await refresh().catch(() => publish({ error: "storage" }));
      if (!state.job) publish({ error: "storage" });
    }
  }
  const api = {
    getSnapshot: () => state,
    setVerificationPaused(value: boolean) {
      verificationPaused = value;
    },
    checkPrinter() {
      if (!state.job || state.job.status === "completed")
        publish({
          error:
            options.canPrint?.() === false
              ? "printer"
              : state.error === "printer"
                ? null
                : state.error,
        });
    },
    list: () =>
      current()
        ? listProductLabelJobViews(exec, credentialOwnership, shiftId)
        : Promise.resolve([]),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    canAccept: () =>
      current() &&
      state.ready &&
      !state.busy &&
      !state.error &&
      !state.closed &&
      options.canPrint?.() !== false &&
      (!state.job || state.job.status === "completed"),
    async open() {
      accepting = true;
      if (initialized) return;
      if (pending) {
        await pending;
        return;
      }
      await run(async () => {
        try {
          await refresh();
          initialized = true;
          publish({ ready: true });
        } catch {
          publish({ error: "storage" });
        }
      });
    },
    close() {
      accepting = false;
      return (pending ?? Promise.resolve()).then(
        () => {},
        () => {},
      );
    },
    idle() {
      return (pending ?? Promise.resolve()).then(
        () => {},
        () => {},
      );
    },
    async accept(raw: string): Promise<ProductLabelAcceptResult> {
      if (!api.canAccept()) return { status: "busy" };
      return run(async () => {
        const input = await options.prepare(raw);
        if (!current()) return { status: "busy" };
        let result: ProductLabelAcceptResult;
        try {
          result = await recordProductLabelAcceptance(exec, input);
        } catch (error) {
          // The statement may have committed before its response was lost. Only an exact
          // immutable command proves acceptance; showing its prepared job never sends it.
          try {
            const [saved] = await exec.all<{ command_digest: string }>(
              "SELECT command_digest FROM product_label_accept_commands WHERE credential_ownership=? AND job_id=?",
              [credentialOwnership, input.jobId],
            );
            if (saved?.command_digest === productLabelValueDigest(input)) {
              await refresh(input.jobId);
              return { status: "accepted", jobId: input.jobId };
            }
            await refresh();
          } catch {
            /* Recovery will retry the saved journal from the blocked screen. */
          }
          publish({ error: "storage" });
          throw error;
        }
        if (result.status !== "accepted") return result;
        try {
          await refresh(result.jobId);
          await send(result.jobId);
        } catch {
          publish({ error: "storage" });
        }
        return result;
      });
    },
    async verify(raw: string): Promise<"match" | "mismatch" | "invalid" | "stale"> {
      const job = state.job;
      if (
        !current() ||
        pending ||
        verificationPaused ||
        !job ||
        !(job.status === "awaiting_verification" || job.attemptState === "delivery_unknown")
      )
        return "stale";
      return run(async () => {
        const result = await verifyProductLabel(exec, {
          ...options.getPrinting(),
          credentialOwnership,
          jobId: job.jobId,
          attemptId: job.attemptId,
          raw,
        });
        await refresh(job.jobId);
        if (result !== "stale") publish({ result });
        return result;
      }).catch(() => {
        publish({ error: "storage" });
        return "stale";
      });
    },
    async resumePrepared() {
      if (state.job?.status !== "prepared") return;
      const jobId = state.job.jobId;
      await run(() => send(jobId));
    },
    async reprint(jobId: string, reason: ReprintReason) {
      await run(async () => {
        await prepareProductLabelReprint(exec, {
          ...options.getPrinting(),
          credentialOwnership,
          shiftId,
          jobId,
          reason,
          recovery: state.closed,
        });
        await refresh(jobId);
        await send(jobId);
      });
    },
    async retry() {
      await run(async () => {
        await refresh();
        initialized = true;
        publish({ ready: true });
      });
    },
  };
  return api;
}
export type ProductLabelWork = ReturnType<typeof createProductLabelWork>;

export interface ProductLabelWorkEnvironment {
  generation: CredentialGeneration;
  deviceId: string;
  operatorName: string | null;
  hardwareConfig: HardwareConfig;
  print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
}
const emptyState: ProductLabelWorkState = {
  ready: true,
  busy: false,
  job: null,
  error: null,
  closed: false,
  result: null,
};
const noSubscribe = () => () => {};
const getEmpty = () => emptyState;

export function useProductLabelWork(input: {
  exec: SqlExecutor;
  shiftId: string;
  terminalId: string | null;
  operatorId: string;
  environment?: ProductLabelWorkEnvironment;
  register?: (barrier: FloorWorkBarrier) => () => void;
}) {
  const { exec, shiftId, environment } = input;
  const current = useRef(input);
  current.current = input;
  const generation = environment?.generation;
  const [loaded, setLoaded] = useState<{
    key: object;
    work: ProductLabelWork | null;
    verification: ProductLabelJobView["verification"] | null;
    error: boolean;
  } | null>(null);
  const key = useMemo(() => ({ exec, shiftId, generation }), [exec, shiftId, generation]);
  useEffect(() => {
    if (!generation) return;
    let active = true;
    let controller: ProductLabelWork | null = null;
    const lease = acquireCredentialCommitLease(generation);
    if (!lease) return;
    const barrier: FloorWorkBarrier = {
      close: () => {
        active = false;
        const closing = controller?.close();
        return Promise.all([operation, closing])
          .then(() => controller?.close())
          .then(() => {});
      },
      idle: () => operation.then(() => controller?.idle()).then(() => {}),
    };
    const unregister = current.current.register?.(barrier);
    const operation = (async () => {
      try {
        const owner = await credentialGenerationOwnership(generation);
        const context = await readDuplicateLabelContext(exec, shiftId);
        if (!active || !credentialGenerationIsCurrent(generation)) return;
        if (!context) {
          setLoaded({ key, work: null, verification: null, error: false });
          return;
        }
        if (!owner) throw new Error("Credential owner missing");
        const getPrinting = (): ProductLabelPrintingDeps => {
          const live = current.current;
          const config = live.environment?.hardwareConfig;
          if (
            !config ||
            !live.environment ||
            live.shiftId !== shiftId ||
            live.environment.generation !== generation
          )
            throw new Error("Printing context missing");
          return {
            exec,
            credentialOwnership: owner,
            operatorId: live.operatorId,
            now: () => new Date().toISOString(),
            newId: () => crypto.randomUUID(),
            target: config.printer,
            language: config.printerLanguage,
            dpi: config.printerDpi ?? null,
            print: live.environment.print,
          };
        };
        controller = createProductLabelWork({
          exec,
          shiftId,
          credentialOwnership: owner,
          generation,
          isCurrent: () =>
            current.current.shiftId === shiftId &&
            current.current.environment?.generation === generation,
          getPrinting,
          canPrint: () => {
            const deps = getPrinting();
            // Any template prints on any printer; only the printer's own
            // resolution must be known (spec 2026-09-10).
            return deps.target !== null && deps.dpi !== null;
          },
          prepare: (raw) => {
            const deps = getPrinting();
            const live = current.current;
            if (!deps.target || !live.environment) throw new Error("Printer is not configured");
            return prepareProductLabelAcceptance({
              raw,
              jobId: crypto.randomUUID(),
              eventId: crypto.randomUUID(),
              attemptId: crypto.randomUUID(),
              shiftId,
              terminalId: live.terminalId ?? live.environment.deviceId,
              deviceId: live.environment.deviceId,
              operatorId: live.operatorId,
              credentialOwnership: owner,
              acceptedAt: deps.now(),
              policy: context.policy,
              labelContext: {
                ...context.labelContext,
                operatorName: live.environment.operatorName,
              },
              language: deps.language,
              printerDpi: deps.dpi,
              rasterizeText,
            });
          },
        });
        await controller.open();
        if (active && credentialGenerationIsCurrent(generation))
          setLoaded({
            key,
            work: controller,
            verification: context.policy.verification,
            error: false,
          });
      } catch {
        if (active) setLoaded({ key, work: null, verification: null, error: true });
      } finally {
        lease.release();
      }
    })();
    return () => {
      active = false;
      const closing = controller?.close();
      void Promise.all([operation, closing])
        .then(() => controller?.close())
        .finally(() => unregister?.());
    };
  }, [exec, shiftId, generation, key]);
  const available = loaded?.key === key ? loaded : null;
  const work = available?.work ?? null;
  useEffect(() => {
    work?.checkPrinter();
  }, [work, environment?.hardwareConfig]);
  const state = useSyncExternalStore(work?.subscribe ?? noSubscribe, work?.getSnapshot ?? getEmpty);
  return {
    work,
    state,
    verification: available?.verification ?? null,
    loading: Boolean(generation && !available),
    error: available?.error ?? false,
  };
}
