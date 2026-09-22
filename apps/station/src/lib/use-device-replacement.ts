import {
  readReplacementEvidenceRecovery,
  reportReplacementEvidenceRecovery,
} from "./replacement-evidence-recovery.js";
import { readTargetReplacementFence } from "./replacement-target.js";
import { useEffect, useRef, useState } from "react";
import {
  deviceReplacementIntentProjectionSchema,
  type DeviceReplacementReadinessRequest,
} from "@markiro/platform-contracts";
import type { StationClient } from "./api-client.js";
import { credentialGenerationIsCurrent, type CredentialGeneration } from "./credential-recovery.js";
import {
  prepareReplacementReadiness,
  applyReplacementClosure,
  acknowledgeReplacementClosure,
  readReplacementDrain,
  replacementCancellationAcknowledged,
  readReplacementMeasurements,
  reportReplacementReadiness,
} from "./device-replacement.js";
import type { SqlExecutor } from "./mirror.js";

export type ReplacementMeasurements = Awaited<ReturnType<typeof readReplacementMeasurements>>;
export interface ReplacementDrainView {
  intentId: string;
  targetWaitingUntil?: number;
  measurements: ReplacementMeasurements | null;
  resumeTasks: DeviceReplacementReadinessRequest["activeTasks"];
  reportFailed: boolean;
}
export function useDeviceReplacement(input: {
  exec: SqlExecutor;
  client: StationClient | null;
  generation: CredentialGeneration | null;
  expectedDevice: { tenantId: string; deviceId: string } | null;
  clientBuild: () => Promise<string>;
  activeTask: DeviceReplacementReadinessRequest["activeTasks"][number] | null;
  onDrain: () => void;
  onCancelled: () => void;
}) {
  const { exec, client, generation } = input;
  const latest = useRef(input);
  latest.current = input;
  const [state, setState] = useState<{
    generation: CredentialGeneration | null;
    loaded: boolean;
    drain: ReplacementDrainView | null;
  }>({ generation: null, loaded: false, drain: null });
  useEffect(() => {
    let active = true,
      running = false;
    const current = () => active && (!generation || credentialGenerationIsCurrent(generation));
    const publish = async (reportFailed: boolean) => {
      const evidence = await readReplacementEvidenceRecovery(exec);
      const target = await readTargetReplacementFence(exec);
      const waiting = target && target.fence.serverTime < target.fence.newWorkAllowedAt;
      const saved = await readReplacementDrain(exec);
      const row = replacementCancellationAcknowledged(saved) ? null : saved;
      const measurements = row ? await readReplacementMeasurements(exec) : null;
      if (current())
        setState({
          generation,
          loaded: true,
          drain: evidence
            ? {
                intentId: evidence.recovery.executionId,
                measurements: await readReplacementMeasurements(exec),
                resumeTasks: [],
                reportFailed,
              }
            : waiting
              ? {
                  intentId: target.fence.executionId,
                  targetWaitingUntil: target.fence.newWorkAllowedAt,
                  measurements: null,
                  resumeTasks: [],
                  reportFailed,
                }
              : row
                ? {
                    intentId: row.intent_id,
                    measurements,
                    resumeTasks: JSON.parse(
                      row.resume_tasks_json,
                    ) as DeviceReplacementReadinessRequest["activeTasks"],
                    reportFailed,
                  }
                : null,
        });
    };
    const run = async () => {
      if (running || !current()) return;
      running = true;
      try {
        // Boot publishes the durable fence before waiting on the network.
        await publish(false);
        if (!generation || !client || !latest.current.expectedDevice || !current()) return;
        const clientBuild = await latest.current.clientBuild();
        const reportInput = { exec, generation, client, clientBuild };
        if (await readReplacementEvidenceRecovery(exec)) {
          await reportReplacementEvidenceRecovery(reportInput);
          await publish(false);
          return;
        }
        const saved = await readReplacementDrain(exec);
        if (saved?.closure_json && !saved.closure_acknowledged_at) {
          if (await acknowledgeReplacementClosure(reportInput)) latest.current.onCancelled();
        }
        if (saved?.state === "draining" && saved.body_json && !saved.acknowledged_at) {
          try {
            await reportReplacementReadiness(reportInput);
          } catch (error) {
            // A cancelled/superseded intent can reject an unaccepted report.
            // Keep its exact body, but still fetch the authoritative closure.
            if (!current() || (error instanceof DOMException && error.name === "AbortError"))
              throw error;
          }
        }
        const projection = deviceReplacementIntentProjectionSchema.parse(
          await client.get(
            `/station/device-replacement-intent/v1${saved ? `?knownIntentId=${encodeURIComponent(saved.intent_id)}` : ""}`,
          ),
        );
        if (!current()) return;
        if (projection.state === "active") {
          await prepareReplacementReadiness({
            exec,
            generation,
            intent: projection.intent,
            expectedDevice: latest.current.expectedDevice,
            ...(latest.current.activeTask ? { activeTask: latest.current.activeTask } : {}),
          });
          if (current() && saved?.intent_id !== projection.intent.intentId)
            latest.current.onDrain();
        } else if (projection.state === "cancelled" || projection.state === "closed") {
          await applyReplacementClosure({ exec, generation, tombstone: projection });
          if (await acknowledgeReplacementClosure(reportInput)) latest.current.onCancelled();
        }
        await publish(false);
        if (current()) await reportReplacementReadiness(reportInput);
        await publish(false);
      } catch {
        // The transport functions propagate cancellation and preserve the row.
        // The lifecycle consumer records failure without clearing the fence.
        if (current()) await publish(true).catch(() => undefined);
      } finally {
        running = false;
      }
    };
    void run();
    const retry = () => void run();
    const timer = window.setInterval(retry, 15_000);
    window.addEventListener("online", retry);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("online", retry);
    };
  }, [exec, client, generation]);
  return state.generation === generation ? state : { generation, loaded: false, drain: null };
}
