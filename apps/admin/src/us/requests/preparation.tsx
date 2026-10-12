import { Button } from "@markiro/ui";
import type {
  UsRequestDetailResponse,
  UsRequestPrepareHttpBody,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import type { RequestPrepareIntent } from "./command-intent.js";
import { matchingRequestValidation, type RequestFreshValidation } from "./validation.js";
import { getRequestCopy } from "./copy.js";

export type RequestPreparationProps = {
  detail: UsRequestDetailResponse;
  fresh: RequestFreshValidation | null;
  intent: RequestPrepareIntent | null;
  canAct: boolean;
  pending: boolean;
  onPrepare: (mode: UsRequestPrepareHttpBody["mode"]) => Promise<void>;
  onReplay: () => Promise<void>;
  onNewResponse: () => void;
};
export function requestCanPrepare(
  detail: UsRequestDetailResponse,
  fresh: RequestFreshValidation | null,
  mode: UsRequestPrepareHttpBody["mode"],
): boolean {
  const validation = matchingRequestValidation(detail, fresh);
  if (
    !validation ||
    detail.status !== "open" ||
    detail.availability.build !== "available" ||
    detail.availability.packageStorage !== "configured"
  )
    return false;
  return (
    mode === "available_records_incomplete" ||
    (validation.matchedRevisionCount > 0 &&
      !validation.findings.some((finding) => finding.severity === "error") &&
      (!validation.findings.some((finding) => finding.severity === "warning") ||
        detail.warningAcknowledgement?.digest === validation.digest))
  );
}
export function RequestPreparation({
  detail,
  fresh,
  intent,
  canAct,
  pending,
  onPrepare,
  onReplay,
  onNewResponse,
}: RequestPreparationProps) {
  const { i18n } = useTranslation();
  const copy = getRequestCopy(i18n.language);
  const gates =
    detail.availability.build === "available" &&
    detail.availability.packageStorage === "configured";
  return (
    <section aria-label={copy.packageTab}>
      <p>{copy.packageHelp}</p>
      <p>{copy.serverRecheck}</p>
      {detail.availability.build !== "available" ? <p>{copy.buildRequired}</p> : null}
      {detail.availability.packageStorage !== "configured" ? <p>{copy.storageRequired}</p> : null}
      {!matchingRequestValidation(detail, fresh) ? <p>{copy.freshRequired}</p> : null}
      <div className="us-request-actions">
        <Button
          disabled={
            !canAct ||
            pending ||
            intent !== null ||
            !requestCanPrepare(detail, fresh, "export_ready")
          }
          onClick={() => void onPrepare("export_ready")}
        >
          {copy.prepareReady}
        </Button>
        <Button
          variant="secondary"
          disabled={
            !canAct ||
            pending ||
            intent !== null ||
            !requestCanPrepare(detail, fresh, "available_records_incomplete")
          }
          onClick={() => void onPrepare("available_records_incomplete")}
        >
          {copy.prepareIncomplete}
        </Button>
      </div>
      <p>{copy.incompleteHelp}</p>
      {intent ? (
        <>
          <p role="note">{copy.memoryIntent}</p>
          <p className="us-request-evidence">{intent.body.idempotencyKey}</p>
          <Button disabled={!canAct || pending || !gates} onClick={() => void onReplay()}>
            {copy.replayPreparation}
          </Button>
          <Button variant="secondary" disabled={pending} onClick={onNewResponse}>
            {copy.newResponse}
          </Button>
        </>
      ) : null}
      {detail.latestRun ? (
        <p>
          {copy.runId}: <code>{detail.latestRun.runId}</code> — {copy[detail.latestRun.status]}
        </p>
      ) : (
        <p>{copy.noRun}</p>
      )}
    </section>
  );
}
