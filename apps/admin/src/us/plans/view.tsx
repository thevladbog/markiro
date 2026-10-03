import { useEffect, useRef, useState } from "react";
import { Button } from "@markiro/ui";
import type { UsPlanDetailResponse, UsPlanListResponse } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { PlanVersions } from "./versions.js";
import { PlanCurrentImpact, PlanDetail } from "./detail.js";
import "./plans.css";

export type PlanViewProps = {
  client: UsBrowserClient;
  canManageQa: boolean;
  canExport: boolean;
  profile: Awaited<ReturnType<UsBrowserClient["profile"]>>;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onOpenProfile: () => void;
  onOpenLocations: () => void;
  onOpenProducts: () => void;
};
type ReadState<T> =
  { kind: "loading" } | { kind: "ready"; value: T } | { kind: "failed"; key: string };
function errorKey(error: unknown, fallback: string) {
  if (!(error instanceof UsClientError)) return fallback;
  if (error.code === "forbidden") return "usPlan.forbidden";
  if (error.code === "session_required") return "usPlan.session";
  if (error.code === "us_plan_version_not_found") return "usPlan.missing";
  return fallback;
}
export function PlanView(props: PlanViewProps) {
  const { client, profile, onForbidden, onSessionLost } = props;
  const { t } = useTranslation();
  const root = useRef<HTMLElement>(null);
  const [list, setList] = useState<ReadState<UsPlanListResponse>>({ kind: "loading" });
  const [detail, setDetail] = useState<ReadState<UsPlanDetailResponse>>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [detailRetry, setDetailRetry] = useState(0);
  const supported = profile.code === "US_FSMA204_PROCESSOR";
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("h1")?.focus();
  }, []);
  useEffect(() => {
    if (!supported) return;
    let active = true;
    setList({ kind: "loading" });
    void client
      .listPlans()
      .then((value) => {
        if (active) setList({ kind: "ready", value });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setList({ kind: "failed", key: errorKey(error, "usPlan.listError") });
        if (error instanceof UsClientError && error.code === "forbidden") void onForbidden();
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
      });
    return () => {
      active = false;
    };
  }, [client, supported, retry, onForbidden, onSessionLost]);
  useEffect(() => {
    if (!supported || !selectedId) return;
    let active = true;
    setDetail({ kind: "loading" });
    void client
      .getPlan(selectedId)
      .then((value) => {
        if (active) setDetail({ kind: "ready", value });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setDetail({ kind: "failed", key: errorKey(error, "usPlan.detailError") });
        if (error instanceof UsClientError && error.code === "forbidden") void onForbidden();
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
      });
    return () => {
      active = false;
    };
  }, [client, supported, selectedId, detailRetry, onForbidden, onSessionLost]);
  if (!supported) return <p role="alert">{t("usPlan.unavailable")}</p>;
  const openDraft =
    list.kind === "ready" ? list.value.items.find((item) => item.status === "draft") : undefined;
  return (
    <section ref={root} className="us-plan-view" aria-label={t("usPlan.title")}>
      <header className="us-plan-heading">
        <div>
          <h1 tabIndex={-1}>{t("usPlan.title")}</h1>
          <p>{t("usPlan.intro")}</p>
        </div>
        {props.canManageQa ? (
          <div>
            <Button disabled aria-describedby="us-plan-draft-hint">
              {t("usPlan.newDraft")}
            </Button>
            <p id="us-plan-draft-hint">
              {openDraft
                ? t("usPlan.draftOpen", { version: openDraft.versionNumber })
                : t("usPlan.draftUnavailable")}
            </p>
          </div>
        ) : null}
      </header>
      {list.kind === "loading" ? (
        <p role="status">{t("usPlan.loading")}</p>
      ) : list.kind === "failed" ? (
        <div role="alert">
          <p>{t(list.key)}</p>
          <Button onClick={() => setRetry((n) => n + 1)}>{t("usPlan.retry")}</Button>
        </div>
      ) : (
        <>
          {list.value.effectiveImpact?.changedSections.length ? (
            <PlanCurrentImpact impact={list.value.effectiveImpact} />
          ) : null}
          <p className="us-plan-publication">
            {t(
              list.value.publicationAvailability === "available"
                ? "usPlan.publicationAvailable"
                : "usPlan.publicationUnavailable",
            )}
          </p>
          {list.value.items.length ? (
            <>
              <PlanVersions
                list={list.value}
                timeZone={profile.timeZone}
                selectedId={selectedId}
                onSelect={(id) => {
                  if (id === selectedId) return;
                  setDetail({ kind: "loading" });
                  setSelectedId(id);
                }}
              />
              {!list.value.items.some((item) => item.status === "effective") ? (
                <p>{t("usPlan.noEffective")}</p>
              ) : null}
            </>
          ) : (
            <div>
              <h2>{t("usPlan.empty")}</h2>
              <p>{t("usPlan.emptyHelp")}</p>
            </div>
          )}
          <p>{t("usPlan.retentionNote", { years: profile.retentionYears })}</p>
          <p className="us-plan-source">{t("usPlan.retentionLimit")}</p>
          {selectedId ? (
            detail.kind === "loading" ? (
              <p role="status">{t("usPlan.detailLoading")}</p>
            ) : detail.kind === "failed" ? (
              <div role="alert">
                <p>{t(detail.key)}</p>
                <Button onClick={() => setDetailRetry((n) => n + 1)}>{t("usPlan.retry")}</Button>
              </div>
            ) : (
              <PlanDetail
                detail={detail.value}
                onOpenProfile={props.onOpenProfile}
                onOpenLocations={props.onOpenLocations}
                onOpenProducts={props.onOpenProducts}
                onClose={() => {
                  const id = selectedId;
                  setSelectedId(null);
                  root.current?.querySelector<HTMLElement>(`[data-plan-version="${id}"]`)?.focus();
                }}
              />
            )
          ) : null}
        </>
      )}
    </section>
  );
}
