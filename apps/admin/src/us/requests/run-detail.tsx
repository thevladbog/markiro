import { useEffect, useState } from "react";
import { Button, DefinitionGrid, Input, StatusChip } from "@markiro/ui";
import { usRequestRetryHttpBodySchema, type UsRequestRunDetail } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import type { UsRequestArtifact } from "./types.js";
import { getRequestCopy } from "./copy.js";
import { formatRequestInstant } from "./time.js";
import { requestScopeKeys } from "./scope.js";
import { RequestDownloadButton, requestArtifactKinds } from "./download.js";

export type RequestRunDetailProps = {
  run: UsRequestRunDetail;
  timeZone: string;
  actorId: string | null;
  canAct: boolean;
  canDownload: boolean;
  storageAvailable: boolean;
  onRetry: (reason: string) => Promise<void>;
  onDownload: (artifact: UsRequestArtifact) => Promise<void>;
};
export function RequestRunDetail(props: RequestRunDetailProps) {
  const { run } = props;
  const { i18n } = useTranslation();
  const copy = getRequestCopy(i18n.language);
  const [reason, setReason] = useState("");
  const active = run.status === "queued" || run.status === "processing";
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [active, run.runId, run.startedAt]);
  const language = i18n.language === "es-US" ? "es-US" : "en-US";
  const instant = (value: string | null) =>
    value === null ? copy.unavailableTiming : formatRequestInstant(value, props.timeZone, language);
  const retry =
    run.status === "failed" &&
    run.lifecycleVersion > 0 &&
    props.actorId !== null &&
    props.actorId === run.createdBy &&
    props.canAct &&
    props.storageAvailable;
  const validReason = usRequestRetryHttpBodySchema.shape.reason.safeParse(reason).success;
  return (
    <section className="us-request-card" aria-label={copy.frozenRun}>
      <h3>{copy.frozenRun}</h3>
      <StatusChip status="neutral" label={copy[run.status]} />
      <p>{copy[run.provenance]}</p>
      <p>{copy.frozenHelp}</p>
      <DefinitionGrid
        items={[
          { term: copy.runId, description: run.runId },
          { term: copy.revision, description: run.requestRevision },
          { term: copy.runRevision, description: run.runRevision },
          { term: copy.mode, description: copy[run.mode] },
          { term: copy.serverExportReady, description: run.exportReady ? copy.yes : copy.no },
          { term: copy.creatorId, description: run.createdBy },
          { term: copy.lifecycleVersion, description: run.lifecycleVersion },
          { term: copy.retryCycle, description: run.retryCycle },
          { term: copy.attemptCount, description: run.attemptCount },
          { term: copy.cycleAttemptCount, description: run.cycleAttemptCount },
          { term: copy.commandDigest, description: run.commandDigest },
          { term: copy.scopedDigest, description: run.scopedContentDigest },
          { term: copy.inputDigest, description: run.inputDigest ?? copy.unavailableTiming },
          { term: copy.requestNumber, description: run.request.requestNumber },
          { term: copy.requesterName, description: run.request.requesterName },
          {
            term: copy.requesterOrganization,
            description: run.request.requesterOrganization ?? "—",
          },
          { term: copy.requesterContact, description: run.request.requesterContact ?? "—" },
          {
            term: copy.alternateDeadlineReason,
            description: run.request.alternateDeadlineReason ?? "—",
          },
          { term: copy.receivedWall, description: instant(run.request.receivedAt) },
          { term: copy.dueWall, description: instant(run.request.dueAt) },
          { term: copy.preparedAt, description: instant(run.startedAt) },
          { term: copy.generationStartedAt, description: instant(run.generationStartedAt) },
          { term: copy.reportRenderedAt, description: instant(run.reportRenderedAt) },
          { term: copy.completedAt, description: instant(run.completedAt) },
          { term: copy.nextAttemptAt, description: instant(run.nextAttemptAt) },
          {
            term: copy.receiptToPreparation,
            description: `${Date.parse(run.startedAt) - Date.parse(run.request.receivedAt)} ms`,
          },
          {
            term: copy.systemElapsed,
            description:
              run.completedAt !== null
                ? `${Date.parse(run.completedAt) - Date.parse(run.startedAt)} ms`
                : copy.unavailableTiming,
          },
          ...(active
            ? [
                {
                  term: copy.localRunningElapsed,
                  description: `${Math.max(0, now - Date.parse(run.startedAt))} ms`,
                },
              ]
            : []),
          {
            term: copy.workerElapsed,
            description:
              run.completedAt !== null && run.generationStartedAt !== null
                ? `${Date.parse(run.completedAt) - Date.parse(run.generationStartedAt)} ms`
                : copy.unavailableTiming,
          },
          { term: copy.failureCode, description: run.failureCode ?? "—" },
        ].map((item, index) => ({ ...item, id: String(index) }))}
      />
      <p>{copy.timingEvidence}</p>
      {active ? <p>{copy.localRunningHelp}</p> : null}
      <h4>{copy.scope}</h4>
      <DefinitionGrid
        items={requestScopeKeys.flatMap((key) => {
          const value = run.scope[key];
          return value === undefined
            ? []
            : [
                {
                  id: key,
                  term: copy[key],
                  description: Array.isArray(value) ? value.join("\n") : value,
                },
              ];
        })}
      />
      <h4>{copy.findings}</h4>
      <pre className="us-request-evidence">{JSON.stringify(run.findings, null, 2)}</pre>
      <h4>{copy.missingFiles}</h4>
      {run.missingFiles === null ? (
        <p>{copy.unavailableTiming}</p>
      ) : run.missingFiles.length === 0 ? (
        <p>{copy.noMissingFiles}</p>
      ) : (
        <ul>
          {run.missingFiles.map((file) => (
            <li key={file.name}>
              {file.name}: {copy[file.code]}
            </li>
          ))}
        </ul>
      )}
      <p>{copy.descriptorEvidence}</p>
      {requestArtifactKinds.map((kind) => {
        const artifact = run.artifacts.find((file) => file.kind === kind);
        return artifact ? (
          <RequestDownloadButton
            key={kind}
            artifact={artifact}
            disabled={!props.canDownload || !props.storageAvailable || run.status !== "ready"}
            active={false}
            onDownload={() => void props.onDownload(artifact)}
          />
        ) : (
          <div key={kind}>
            <Button disabled>
              {copy.download} {copy[kind]}
            </Button>
            <p>{copy.artifactAbsent}</p>
          </div>
        );
      })}
      {run.status === "failed" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (retry && validReason) void props.onRetry(reason);
          }}
        >
          <Input
            label={copy.retryReason}
            value={reason}
            disabled={!retry}
            onChange={(event) => setReason(event.target.value)}
          />
          <p>{copy.retryHelp}</p>
          <Button type="submit" disabled={!retry || !validReason}>
            {copy.retryRun}
          </Button>
        </form>
      ) : null}
      {run.status === "queued" ? <p>{copy.queuedHelp}</p> : null}
    </section>
  );
}
