import { useId, useState, type ReactNode } from "react";
import { DataTabs, DefinitionGrid, StatusChip } from "@markiro/ui";
import type { UsRequestDetailResponse } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { getRequestCopy } from "./copy.js";
import { RequestDeadline, useRequestMinute } from "./list.js";
import { formatRequestInstant } from "./time.js";
import { requestScopeKeys } from "./scope.js";

export type RequestCardProps = {
  detail: UsRequestDetailResponse;
  timeZone: string;
  children?: ReactNode;
  validationContent?: ReactNode;
  packageContent?: ReactNode;
};
type Tab = "requester" | "scope" | "validation" | "package";

export function RequestCard({
  detail,
  timeZone,
  children,
  validationContent,
  packageContent,
}: RequestCardProps) {
  const { i18n } = useTranslation();
  const copy = getRequestCopy(i18n.language);
  const language = i18n.language === "es-US" ? "es-US" : "en-US";
  const [tab, setTab] = useState<Tab>("requester");
  const panel = useId();
  const now = useRequestMinute();
  const instant = (value: string) => formatRequestInstant(value, timeZone, language);
  const validation = detail.savedValidation;
  return (
    <section
      className="us-request-card"
      aria-label={`${copy.requestNumber} ${detail.requestNumber}`}
    >
      <header>
        <h2>{detail.requestNumber}</h2>
        <StatusChip status="neutral" label={copy[detail.status]} />
        <p>
          {copy.revision}: <span className="font-mono">{detail.revision}</span>
        </p>
        <div aria-live="polite" aria-atomic="true">
          <RequestDeadline row={detail} timeZone={timeZone} now={now} />
        </div>
      </header>
      <DataTabs
        label={copy.steps}
        activeId={tab}
        onChange={setTab}
        items={[
          { id: "requester", label: copy.requesterTab, panelId: panel },
          { id: "scope", label: copy.scopeTab, panelId: panel },
          { id: "validation", label: copy.validationTab, panelId: panel },
          { id: "package", label: copy.packageTab, panelId: panel },
        ]}
      />
      <div
        id={panel}
        role="tabpanel"
        aria-label={tab === "requester" ? copy.requesterTab : copy[`${tab}Tab`]}
        tabIndex={0}
      >
        {tab === "requester" ? (
          <DefinitionGrid
            items={[
              { term: copy.requesterName, description: detail.requesterName },
              {
                term: copy.requesterOrganization,
                description: detail.requesterOrganization ?? "—",
              },
              { term: copy.requesterContact, description: detail.requesterContact ?? "—" },
              { term: copy.receivedWall, description: instant(detail.receivedAt) },
              { term: copy.dueWall, description: instant(detail.dueAt) },
              {
                term: copy.alternateDeadlineReason,
                description: detail.alternateDeadlineReason ?? "—",
              },
            ].map((item, index) => ({ ...item, id: String(index) }))}
          />
        ) : tab === "scope" ? (
          <>
            <p>{copy.scopeHelp}</p>
            {detail.scope ? (
              <DefinitionGrid
                items={requestScopeKeys.flatMap((key) => {
                  const value = detail.scope?.[key];
                  return value === undefined
                    ? []
                    : [
                        {
                          id: key,
                          term: copy[key],
                          description: Array.isArray(value) ? value.join("\n") : value,
                          mono: true,
                        },
                      ];
                })}
              />
            ) : (
              <p>{copy.noScope}</p>
            )}
            <p>{copy.scopeEvidenceHelp}</p>
          </>
        ) : tab === "validation" && validationContent !== undefined ? (
          validationContent
        ) : tab === "package" && packageContent !== undefined ? (
          packageContent
        ) : tab === "validation" ? (
          <>
            <p>{copy.savedOnly}</p>
            {validation ? (
              <>
                <DefinitionGrid
                  items={[
                    { term: copy.validationDigest, description: validation.digest, mono: true },
                    { term: copy.validatedAt, description: instant(validation.validatedAt) },
                    { term: copy.matchedRevisions, description: validation.matchedRevisionCount },
                  ].map((item, index) => ({ ...item, id: String(index) }))}
                />
                <pre className="us-request-evidence">
                  {JSON.stringify(validation.findings, null, 2)}
                </pre>
                {detail.warningAcknowledgement ? (
                  <p>
                    {copy.acknowledgement}: {detail.warningAcknowledgement.reason}
                  </p>
                ) : null}
              </>
            ) : (
              <p>{copy.noValidation}</p>
            )}
          </>
        ) : (
          <>
            <p>{copy.packageHelp}</p>
            {detail.latestRun ? (
              <DefinitionGrid
                items={[
                  { term: copy.runId, description: detail.latestRun.runId, mono: true },
                  { term: copy.runRevision, description: detail.latestRun.runRevision },
                  { term: copy.runStatus, description: copy[detail.latestRun.status] },
                ].map((item, index) => ({ ...item, id: String(index) }))}
              />
            ) : (
              <p>{copy.noRun}</p>
            )}
          </>
        )}
      </div>
      {children}
    </section>
  );
}
