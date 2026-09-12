import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, ConfirmDialog, Input, Select, StatusChip } from "@markiro/ui";
import type {
  DeviceReplacementObservation,
  DeviceReplacementPreparation,
  WorkingDevicePool,
} from "@markiro/platform-contracts";
import { useAuthClient } from "../../auth/client.js";
import {
  listDeviceReplacements,
  previewDeviceReplacement,
  confirmDeviceReplacement,
  cancelDeviceReplacement,
  replacementErrorKind,
} from "./replacement-api.js";
import {
  emptyAttempt,
  replacementKeys,
  useReplacementCache,
  useReplacementPending,
  type PrepareAttempt,
  type CancelAttempt,
} from "./replacement-state.js";

export function DeviceReplacementPanel({
  pool,
  canWrite,
}: {
  pool: WorkingDevicePool;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: replacementKeys.list(pool.tenantId),
    queryFn: () => listDeviceReplacements(pool.tenantId),
  });
  const [sourceId, setSourceId] = useReplacementCache(replacementKeys.selection(pool.tenantId), "");
  const pending = useReplacementPending(pool.tenantId);
  const writable = canWrite && list.data?.canPrepare === true;
  const changeSource = (nextSourceId: string) => {
    const key = replacementKeys.prepare(pool.tenantId, sourceId);
    const previous = qc.getQueryData<PrepareAttempt>(key);
    if (nextSourceId === sourceId || pending || previous?.pending) return;
    // Ordinary source edits require a new preview. An ambiguous operation still
    // owns its original identity and can be recovered when this source is revisited.
    if (previous && previous.notice !== "uncertain") {
      qc.setQueryData<PrepareAttempt>(key, { intent: previous.intent });
    }
    setSourceId(nextSourceId);
  };
  const candidates = pool.devices.filter(
    (device) =>
      device.state === "assigned" ||
      (device.state === "released" && device.releaseReason === "security_revoked"),
  );
  return (
    <Card title={t("deviceReplacement.title")} titleAs="h2">
      <p>{t("deviceReplacement.intro")}</p>
      {list.isPending ? (
        <p role="status">{t("deviceReplacement.loading")}</p>
      ) : list.isError ? (
        <Alert tone="error">{t("deviceReplacement.loadError")}</Alert>
      ) : null}
      {list.data && !writable ? <p>{t("deviceReplacement.readonly")}</p> : null}
      {writable ? (
        <>
          <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0 }}>
            <Select
              label={t("deviceReplacement.source")}
              value={sourceId}
              onValueChange={changeSource}
              options={[
                { value: "", label: t("deviceReplacement.chooseSource") },
                ...candidates.map((device) => ({ value: device.deviceId, label: device.name })),
              ]}
            />
          </fieldset>
          {sourceId && candidates.some((device) => device.deviceId === sourceId) ? (
            <PreparationEditor
              key={`${pool.tenantId}:${sourceId}`}
              tenantId={pool.tenantId}
              sourceId={sourceId}
              canWrite={writable}
            />
          ) : null}
        </>
      ) : null}
      {list.data?.items.map((item) => (
        <SavedPreparation
          key={`${pool.tenantId}:${item.preparation.id}`}
          tenantId={pool.tenantId}
          preparation={item.preparation}
          needsReview={item.needsReview}
          canWrite={writable}
        />
      ))}
    </Card>
  );
}
function useRefresh(tenantId: string) {
  const qc = useQueryClient();
  const session = useAuthClient().useSession();
  return async (auth = false) => {
    await Promise.allSettled([
      qc.invalidateQueries({ queryKey: replacementKeys.list(tenantId) }),
      qc.invalidateQueries({ queryKey: ["device-licensing"] }),
      qc.invalidateQueries({ queryKey: ["devices"] }),
      qc.invalidateQueries({ queryKey: ["billing", "entitlements"] }),
      ...(auth
        ? [
            Promise.resolve(session.refetch?.()),
            qc.invalidateQueries({ queryKey: ["cabinet-access"] }),
          ]
        : []),
    ]);
  };
}
function PreparationEditor({
  tenantId,
  sourceId,
  canWrite,
}: {
  tenantId: string;
  sourceId: string;
  canWrite: boolean;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const key = replacementKeys.prepare(tenantId, sourceId);
  const [attempt, setAttempt] = useReplacementCache<PrepareAttempt>(key, emptyAttempt);
  const busy = useReplacementPending(tenantId);
  const refresh = useRefresh(tenantId);
  const edit = (patch: Partial<PrepareAttempt["intent"]>) => {
    if (!busy) setAttempt({ intent: { ...attempt.intent, ...patch } });
  };
  const run = async (confirm: boolean) => {
    // Read the cache again: a second click or a remounted observer must not race.
    const current = qc.getQueryData<PrepareAttempt>(key) ?? attempt;
    if (!canWrite || busy || current.pending) return;
    const request = current.request ?? {
      requestId: crypto.randomUUID(),
      target: { name: current.intent.name.trim(), kind: current.intent.kind },
      reason: current.intent.reason.trim(),
    };
    const next: PrepareAttempt = {
      intent: current.intent,
      request,
      ...(current.preview ? { preview: current.preview } : {}),
      pending: true,
    };
    setAttempt(next);
    try {
      if (confirm && current.preview) {
        await confirmDeviceReplacement(tenantId, sourceId, {
          requestId: request.requestId,
          previewId: current.preview.id,
        });
        setAttempt({ ...emptyAttempt, notice: "saved" });
        await refresh();
      } else {
        const preview = await previewDeviceReplacement(tenantId, sourceId, request);
        setAttempt({ intent: current.intent, request, preview });
      }
    } catch (error) {
      const kind = replacementErrorKind(error);
      if (kind === "uncertain") setAttempt({ ...next, pending: false, notice: kind });
      else {
        setAttempt({ intent: current.intent, notice: kind });
        await refresh(kind === "authorization");
      }
    }
  };
  return (
    <div style={{ display: "grid", gap: "var(--sp-3)", marginBlock: "var(--sp-4)" }}>
      <fieldset
        disabled={busy || !canWrite}
        style={{ display: "grid", gap: "var(--sp-3)", border: 0, padding: 0, margin: 0 }}
      >
        <Input
          label={t("deviceReplacement.targetName")}
          value={attempt.intent.name}
          maxLength={200}
          onChange={(event) => edit({ name: event.target.value })}
        />
        <Select
          label={t("deviceReplacement.targetKind")}
          value={attempt.intent.kind}
          onValueChange={(kind) => edit({ kind })}
          options={[
            { value: "station", label: t("deviceReplacement.kind.station") },
            { value: "handheld", label: t("deviceReplacement.kind.handheld") },
          ]}
        />
        <Input
          label={t("deviceReplacement.reason")}
          value={attempt.intent.reason}
          maxLength={1000}
          onChange={(event) => edit({ reason: event.target.value })}
        />
      </fieldset>
      {attempt.notice ? (
        <Alert
          tone={
            attempt.notice === "saved" ? "ok" : attempt.notice === "conflict" ? "warn" : "error"
          }
        >
          {t(`deviceReplacement.${attempt.notice}`)}
        </Alert>
      ) : null}
      {attempt.preview ? (
        <>
          <Observation observation={attempt.preview.observation} />
          <p>
            {t("deviceReplacement.expires", {
              at: new Date(attempt.preview.expiresAt).toLocaleString(
                i18n.resolvedLanguage ?? i18n.language,
              ),
            })}
          </p>
          <Button disabled={busy || !canWrite} onClick={() => void run(true)}>
            {t("deviceReplacement.save")}
          </Button>
        </>
      ) : (
        <Button
          variant="secondary"
          disabled={
            busy || !canWrite || !attempt.intent.name.trim() || !attempt.intent.reason.trim()
          }
          onClick={() => void run(false)}
        >
          {t("deviceReplacement.preview")}
        </Button>
      )}
    </div>
  );
}
function SavedPreparation({
  tenantId,
  preparation,
  needsReview,
  canWrite,
}: {
  tenantId: string;
  preparation: DeviceReplacementPreparation;
  needsReview: boolean;
  canWrite: boolean;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const key = replacementKeys.cancel(tenantId, preparation.sourceDeviceId, preparation.id);
  const [attempt, setAttempt] = useReplacementCache<CancelAttempt | null>(key, null);
  const [open, setOpen] = useState(false);
  const busy = useReplacementPending(tenantId);
  const refresh = useRefresh(tenantId);
  const cancel = async () => {
    const current = qc.getQueryData<CancelAttempt>(key);
    if (!canWrite || busy || current?.pending) return;
    const next: CancelAttempt = {
      request: current?.request ?? {
        requestId: crypto.randomUUID(),
        expectedRevision: preparation.revision,
      },
      pending: true,
    };
    setAttempt(next);
    try {
      await cancelDeviceReplacement(tenantId, preparation.id, next.request);
      setAttempt(null);
      setOpen(false);
      await refresh();
    } catch (error) {
      const kind = replacementErrorKind(error);
      if (kind === "uncertain") setAttempt({ ...next, pending: false, notice: kind });
      else {
        setAttempt(null);
        setOpen(false);
        setNotice(kind);
        await refresh(kind === "authorization");
      }
    }
  };
  const [notice, setNotice] = useState<"authorization" | "conflict" | null>(null);
  return (
    <section
      aria-label={t("deviceReplacement.project")}
      style={{ display: "grid", gap: "var(--sp-3)", marginBlock: "var(--sp-4)" }}
    >
      <StatusChip status="neutral" label={t(`deviceReplacement.state.${preparation.state}`)} />
      {needsReview && preparation.state === "prepared" ? (
        <Alert tone="warn">{t("deviceReplacement.needsReview")}</Alert>
      ) : null}
      <p>
        {t("deviceReplacement.observed", {
          at: new Date(preparation.preparedAt).toLocaleString(
            i18n.resolvedLanguage ?? i18n.language,
          ),
        })}
      </p>
      <Observation observation={preparation.observation} historical />
      {notice ? <Alert tone="error">{t(`deviceReplacement.${notice}`)}</Alert> : null}
      {attempt?.notice && !(open && canWrite) ? (
        <Alert tone="error">{t(`deviceReplacement.${attempt.notice}`)}</Alert>
      ) : null}
      {canWrite && (preparation.state === "prepared" || attempt) ? (
        <Button variant="secondary" disabled={busy} onClick={() => setOpen(true)}>
          {t("deviceReplacement.cancel")}
        </Button>
      ) : null}
      <ConfirmDialog
        open={open && canWrite}
        title={t("deviceReplacement.cancel")}
        description={t("deviceReplacement.cancelBody")}
        error={attempt?.notice ? t(`deviceReplacement.${attempt.notice}`) : undefined}
        confirmLabel={t("deviceReplacement.cancelConfirm")}
        cancelLabel={t("deviceReplacement.back")}
        busy={busy}
        onCancel={() => {
          if (!busy) setOpen(false);
        }}
        onConfirm={() => void cancel()}
      />
    </section>
  );
}
function Observation({
  observation: o,
  historical = false,
}: {
  observation: DeviceReplacementObservation;
  historical?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ display: "grid", gap: "var(--sp-2)" }}>
      <p>
        {t("deviceReplacement.transition", {
          oldName: o.source.name,
          oldKind: t(`deviceReplacement.kind.${o.source.kind}`),
          newName: o.target.name,
          newKind: t(`deviceReplacement.kind.${o.target.kind}`),
        })}
      </p>
      <p>
        {t(
          historical
            ? o.limit === null
              ? "deviceReplacement.slotsSavedUnlimited"
              : "deviceReplacement.slotsSaved"
            : o.limit === null
              ? "deviceReplacement.slotsUnlimited"
              : "deviceReplacement.slots",
          {
            usage: o.usage,
            limit: o.limit,
          },
        )}
      </p>
      <p>{t("deviceReplacement.delta", { delta: o.expectedTransferSlotDelta })}</p>
      <p>{t("deviceReplacement.serverWork", o.knownServerWork)}</p>
      <Alert tone="warn">{t("deviceReplacement.localUnknown")}</Alert>
      <ul>
        {o.execution.reasons.map((reason) => (
          <li key={reason}>{t(`deviceReplacement.unavailable.${reason}`)}</li>
        ))}
      </ul>
    </div>
  );
}
