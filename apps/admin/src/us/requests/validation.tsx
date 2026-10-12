import { useState } from "react";
import { Button, Input, DefinitionGrid } from "@markiro/ui";
import {
  usRequestWarningAckHttpBodySchema,
  type UsRequestDetailResponse,
  type UsRequestValidationHttpResponse,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import type { ReadinessEventTarget } from "../readiness/source.js";
import { getRequestCopy } from "./copy.js";
import { requestFindingTarget } from "./source.js";

export type RequestFreshValidation = {
  requestId: string;
  revision: number;
  response: UsRequestValidationHttpResponse;
};
export function matchingRequestValidation(
  detail: UsRequestDetailResponse,
  fresh: RequestFreshValidation | null,
) {
  return fresh &&
    fresh.requestId === detail.id &&
    fresh.revision === detail.revision &&
    fresh.response.requestId === detail.id &&
    fresh.response.revision === detail.revision &&
    /^[a-f0-9]{64}$/.test(fresh.response.digest) &&
    (!detail.savedValidation || detail.savedValidation.digest === fresh.response.digest)
    ? fresh.response
    : null;
}
export type RequestValidationProps = {
  detail: UsRequestDetailResponse;
  fresh: RequestFreshValidation | null;
  canAct: boolean;
  pending: boolean;
  onValidate: () => Promise<void>;
  onAcknowledge: (reason: string) => Promise<void>;
  onOpenSource: (target: ReadinessEventTarget) => void;
};
export function RequestValidation({
  detail,
  fresh,
  canAct,
  pending,
  onValidate,
  onAcknowledge,
  onOpenSource,
}: RequestValidationProps) {
  const { i18n } = useTranslation();
  const copy = getRequestCopy(i18n.language);
  const [reason, setReason] = useState("");
  const current = matchingRequestValidation(detail, fresh);
  const evidence = current ?? detail.savedValidation;
  const ackValid =
    evidence &&
    usRequestWarningAckHttpBodySchema.safeParse({
      expectedRevision: detail.revision,
      digest: evidence.digest,
      reason,
    }).success;
  return (
    <section aria-label={copy.validationTab}>
      <p>{current ? copy.freshValidation : copy.savedOnly}</p>
      <Button
        disabled={
          !canAct ||
          pending ||
          detail.status !== "open" ||
          detail.scope === null ||
          detail.availability.build !== "available"
        }
        onClick={() => void onValidate()}
      >
        {copy.validate}
      </Button>
      {detail.scope === null ? <p>{copy.scopeRequired}</p> : null}
      {detail.availability.build !== "available" ? <p>{copy.buildRequired}</p> : null}
      {evidence ? (
        <>
          <DefinitionGrid
            items={[
              {
                id: "digest",
                term: copy.validationDigest,
                description: evidence.digest,
                mono: true,
              },
              { id: "time", term: copy.validatedAt, description: evidence.validatedAt, mono: true },
              {
                id: "count",
                term: copy.matchedRevisions,
                description: evidence.matchedRevisionCount,
              },
            ]}
          />
          {evidence.matchedRevisionCount === 0 ? <p>{copy.zeroMatches}</p> : null}
          {(["error", "warning", "info"] as const).map((severity) => {
            const findings = evidence.findings.filter((finding) => finding.severity === severity);
            return findings.length ? (
              <section key={severity} aria-label={copy[severity]}>
                <h3>{copy[severity]}</h3>
                <ul>
                  {findings.map((finding, index) => {
                    const target = requestFindingTarget(finding);
                    return (
                      <li key={index}>
                        <code>{finding.code}</code>
                        <p className="us-request-evidence">{finding.sourceRecord}</p>
                        <p>{finding.message}</p>
                        {finding.revision !== undefined ? (
                          <p>
                            {copy.revision}: {finding.revision}
                          </p>
                        ) : null}
                        {finding.lineNo !== undefined ? (
                          <p>
                            {copy.line}: {finding.lineNo}
                          </p>
                        ) : null}
                        {finding.fieldKey ? <code>{finding.fieldKey}</code> : null}
                        {target ? (
                          <Button
                            variant="secondary"
                            disabled={pending}
                            onClick={() => onOpenSource(target)}
                          >
                            {copy.openSource}
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null;
          })}
          {evidence.findings.some((finding) => finding.severity === "warning") ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (canAct && !pending && ackValid && detail.status === "open")
                  void onAcknowledge(reason);
              }}
            >
              <Input
                label={copy.ackReason}
                value={reason}
                disabled={!canAct || pending}
                onChange={(event) => setReason(event.target.value)}
              />
              <p>{copy.ackHelp}</p>
              <Button
                type="submit"
                disabled={!canAct || pending || !ackValid || detail.status !== "open"}
              >
                {copy.ackWarnings}
              </Button>
            </form>
          ) : null}
          {detail.warningAcknowledgement ? (
            <p>
              {copy.acknowledgement}: {detail.warningAcknowledgement.reason}
            </p>
          ) : null}
        </>
      ) : (
        <p>{copy.noValidation}</p>
      )}
    </section>
  );
}
