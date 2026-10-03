import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@markiro/ui";
import type { UsPlanDetailResponse, UsPlanListResponse } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { PlanVersions } from "./versions.js";
import { PlanCurrentImpact, PlanDetail } from "./detail.js";
import { PlanEditor } from "./editor.js";
import { PlanInspection } from "./inspection.js";
import { PlanApproval } from "./approval.js";
import { emptyPlanSections } from "./section-fields.js";
import "./plans.css";

export type PlanViewProps = {
  client: UsBrowserClient;
  canManageQa: boolean;
  canExport: boolean;
  profile: Awaited<ReturnType<UsBrowserClient["profile"]>>;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onMutationPendingChange?: (pending: boolean) => void;
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
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [writeBlocked, setWriteBlocked] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createPending = useRef(false);
  const { onMutationPendingChange } = props;
  const onEditorPending = useCallback(
    (pending: boolean) => {
      setSaving(pending);
      onMutationPendingChange?.(pending);
    },
    [onMutationPendingChange],
  );
  const onActionPending = useCallback(
    (pending: boolean) => {
      setActionPending(pending);
      onMutationPendingChange?.(pending);
    },
    [onMutationPendingChange],
  );
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
  function mayLeave() {
    return (
      !creating && !saving && !actionPending && (!dirty || window.confirm(t("md.discardConfirm")))
    );
  }
  function openVersion(id: string, edit = false) {
    if (!mayLeave()) return;
    setDirty(false);
    props.onDirtyChange(false);
    setEditing(edit);
    if (id === selectedId) return;
    setDetail({ kind: "loading" });
    setSelectedId(id);
  }
  async function createDraft() {
    if (
      list.kind !== "ready" ||
      openDraft ||
      !props.canManageQa ||
      writeBlocked ||
      createPending.current ||
      !mayLeave()
    )
      return;
    createPending.current = true;
    setCreating(true);
    onMutationPendingChange?.(true);
    props.onDirtyChange(true);
    setCreateError(null);
    try {
      const effective = list.value.items.find((item) => item.status === "effective");
      const source = effective ? await client.getPlan(effective.id) : null;
      if (source && source.status !== "effective") throw new Error("Effective version changed");
      const result = await client.createPlan({
        sections: source?.snapshot.sections ?? emptyPlanSections(),
        changeSummary: "",
      });
      setEditing(true);
      setSelectedId(result.id);
      setDetail({ kind: "loading" });
      setRetry((n) => n + 1);
    } catch (error) {
      setCreateError(errorKey(error, "usPlan.createError"));
      setRetry((n) => n + 1);
      if (error instanceof UsClientError && error.code === "forbidden") {
        setWriteBlocked(true);
        await onForbidden();
      }
      if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
    } finally {
      createPending.current = false;
      setCreating(false);
      onMutationPendingChange?.(false);
      props.onDirtyChange(false);
    }
  }
  return (
    <section ref={root} className="us-plan-view" aria-label={t("usPlan.title")}>
      <header className="us-plan-heading">
        <div>
          <h1 tabIndex={-1}>{t("usPlan.title")}</h1>
          <p>{t("usPlan.intro")}</p>
        </div>
        {props.canManageQa ? (
          <div>
            <Button
              disabled={
                list.kind !== "ready" ||
                Boolean(openDraft) ||
                creating ||
                actionPending ||
                writeBlocked
              }
              aria-describedby="us-plan-draft-hint"
              onClick={() => void createDraft()}
            >
              {t(creating ? "usPlan.creating" : "usPlan.newDraft")}
            </Button>
            <p id="us-plan-draft-hint">
              {openDraft
                ? t("usPlan.draftOpen", { version: openDraft.versionNumber })
                : t("usPlan.createHint")}
            </p>
            {openDraft ? (
              <Button
                disabled={
                  creating ||
                  saving ||
                  actionPending ||
                  writeBlocked ||
                  (editing && selectedId === openDraft.id)
                }
                variant="secondary"
                onClick={() => openVersion(openDraft.id, true)}
              >
                {t("usPlan.editDraft")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>
      {createError ? <p role="alert">{t(createError)}</p> : null}
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
                  openVersion(id);
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
            ) : editing && detail.value.status === "draft" ? (
              <PlanEditor
                key={detail.value.id}
                draft={detail.value}
                profile={profile}
                canManageQa={props.canManageQa && !writeBlocked && !actionPending}
                inspection={{ client, canExport: props.canExport }}
                onSave={async (id, body) => {
                  const acknowledgement = await client.savePlan(id, body);
                  setDetail({
                    kind: "ready",
                    value: { ...acknowledgement, provenance: detail.value.provenance },
                  });
                  return acknowledgement;
                }}
                onReload={async () => {
                  const value = await client.getPlan(detail.value.id);
                  if (value.status !== "draft") {
                    setDirty(false);
                    props.onDirtyChange(false);
                  }
                  setDetail({ kind: "ready", value });
                  return value;
                }}
                onMutationPendingChange={onEditorPending}
                onDirtyChange={(value) => {
                  setDirty(value);
                  props.onDirtyChange(value);
                }}
                onForbidden={onForbidden}
                onSessionLost={onSessionLost}
                onOpenProfile={props.onOpenProfile}
                onOpenLocations={props.onOpenLocations}
                onOpenProducts={props.onOpenProducts}
              />
            ) : (
              <>
                <PlanDetail
                  key={detail.value.id}
                  detail={detail.value}
                  download={{
                    client,
                    canExport: props.canExport,
                    availability: list.value.publicationAvailability,
                    onForbidden,
                    onSessionLost,
                  }}
                  onOpenProfile={props.onOpenProfile}
                  onOpenLocations={props.onOpenLocations}
                  onOpenProducts={props.onOpenProducts}
                  onClose={() => {
                    if (!mayLeave()) return;
                    const id = selectedId;
                    setSelectedId(null);
                    root.current
                      ?.querySelector<HTMLElement>(`[data-plan-version="${id}"]`)
                      ?.focus();
                  }}
                />
                {detail.value.status === "draft" ? (
                  <PlanInspection
                    key={`${detail.value.id}:${detail.value.draftRevision}`}
                    client={client}
                    draft={detail.value}
                    dirty={false}
                    saving={false}
                    canValidate={false}
                    canExport={props.canExport}
                    onOpenLocations={props.onOpenLocations}
                    onForbidden={onForbidden}
                    onSessionLost={onSessionLost}
                  />
                ) : null}
              </>
            )
          ) : null}
          {detail.kind === "ready" && selectedId && detail.value.status === "draft" ? (
            <PlanApproval
              draft={detail.value}
              client={client}
              availability={list.value.publicationAvailability}
              dirty={dirty}
              saving={saving}
              canManageQa={props.canManageQa && !writeBlocked}
              onMutationPendingChange={onActionPending}
              onForbidden={onForbidden}
              onSessionLost={onSessionLost}
              onApproved={async (receipt) => {
                const versions = await client.listPlans();
                const value = await client.getPlan(receipt.id);
                setList({ kind: "ready", value: versions });
                setDetail({ kind: "ready", value });
                setEditing(false);
                setDirty(false);
                props.onDirtyChange(false);
              }}
              onDiscarded={async () => {
                const versions = await client.listPlans();
                setList({ kind: "ready", value: versions });
                setSelectedId(null);
                setDetail({ kind: "loading" });
                setEditing(false);
                setDirty(false);
                props.onDirtyChange(false);
                root.current?.querySelector<HTMLElement>("h1")?.focus();
              }}
              onReload={async () => {
                const value = await client.getPlan(detail.value.id);
                const versions = await client.listPlans();
                setDetail({ kind: "ready", value });
                setList({ kind: "ready", value: versions });
                // Remount the editor only after an explicit reload; local text
                // never changes as a side effect of a failed approval.
                setEditing(false);
                setDirty(false);
                props.onDirtyChange(false);
              }}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
