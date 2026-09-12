import type { ReactNode } from "react";
import { Alert, Button, Card, Checkbox, Input } from "../components/index.js";
import type {
  DeviceRetentionObservation,
  DeviceRetentionPreview,
  DeviceRetentionPreviewRequest,
  DeviceRetentionReceipt,
  DeviceRetentionInspection,
  DeviceRetentionConfirm,
  EntitlementSnapshotV1,
} from "@markiro/platform-contracts";
export type DeviceRetentionAttempt = {
  ids: string[];
  reason: string;
  expectedRevision?: number;
  boundaryKey?: string;
  request?: DeviceRetentionPreviewRequest;
  preview?: DeviceRetentionPreview;
  observation?: DeviceRetentionObservation;
  receipt?: DeviceRetentionReceipt;
  pending?: boolean;
  notice?: "uncertain" | "authorization" | "conflict";
};
export const emptyDeviceRetentionAttempt: DeviceRetentionAttempt = { ids: [], reason: "" };
export type DeviceRetentionTranslate = (key: string, options?: Record<string, unknown>) => string;
export type DeviceRetentionNotice = "uncertain" | "authorization" | "conflict";
export interface DeviceRetentionViewProps {
  canWrite: boolean;
  inspection: { data: DeviceRetentionInspection | undefined; isPending: boolean; isError: boolean };
  attempt: DeviceRetentionAttempt;
  getAttempt: () => DeviceRetentionAttempt;
  setAttempt: (attempt: DeviceRetentionAttempt) => void;
  preview: (request: DeviceRetentionPreviewRequest) => Promise<DeviceRetentionPreview>;
  confirm: (
    request: DeviceRetentionConfirm,
    expected: DeviceRetentionPreview,
  ) => Promise<DeviceRetentionReceipt>;
  refresh: () => Promise<unknown>;
  classifyError: (error: unknown) => DeviceRetentionNotice;
  createRequestId: () => string;
  translate: DeviceRetentionTranslate;
  language: string;
  renderSnapshot: (snapshot: EntitlementSnapshotV1) => ReactNode;
}
export function DeviceRetentionView({
  canWrite,
  inspection,
  attempt,
  getAttempt,
  setAttempt,
  preview: requestPreview,
  confirm: requestConfirm,
  refresh,
  classifyError,
  createRequestId,
  translate: t,
  language,
  renderSnapshot,
}: DeviceRetentionViewProps) {
  const view = { translate: t, language, renderSnapshot };
  const writable = canWrite && inspection.data?.canSelect === true;
  const locked = attempt.pending === true || attempt.notice === "uncertain";
  const live = inspection.data?.observation;
  // Recovery owns its original observation even when the live boundary disappears.
  const observation =
    attempt.preview?.observation ?? (locked ? (attempt.observation ?? live) : live);
  const saved = inspection.data?.selections
    .filter((item) => item.selection.observation.boundary.key === live?.boundary.key)
    .reduce<(typeof inspection.data.selections)[number] | undefined>(
      (latest, item) =>
        !latest || item.selection.revision > latest.selection.revision ? item : latest,
      undefined,
    );
  // Membership belongs to the boundary key; concurrency belongs to the stored date.
  const revision =
    inspection.data?.selections.reduce((latest, item) => {
      const boundary = item.selection.observation.boundary;
      return live &&
        (boundary.key === live.boundary.key ||
          Date.parse(boundary.effectiveAt) === Date.parse(live.boundary.effectiveAt))
        ? Math.max(latest, item.selection.revision)
        : latest;
    }, 0) ?? 0;
  const stale =
    attempt.notice === "conflict" ||
    (attempt.boundaryKey !== undefined &&
      (attempt.boundaryKey !== live?.boundary.key || attempt.expectedRevision !== revision));
  const editable =
    writable && !locked && !stale && (!saved || attempt.expectedRevision !== undefined);
  const invalid =
    !!observation &&
    (attempt.ids.some(
      (id) => !observation.devices.some((device) => device.deviceId === id && device.eligible),
    ) ||
      (observation.future.candidate.quotas.stations.limit !== null &&
        attempt.ids.length > observation.future.candidate.quotas.stations.limit));
  const date = (value: string) =>
    new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
      timeStyle: "long",
      timeZone: "Europe/Moscow",
    }).format(new Date(value));
  const edit = (ids: string[], reason: string) => {
    if (!editable || !live) return;
    setAttempt({
      ...(attempt.receipt ? { receipt: attempt.receipt } : {}),
      ids,
      reason,
      expectedRevision: attempt.expectedRevision ?? revision,
      boundaryKey: live.boundary.key,
    });
  };
  const begin = (blank = false) => {
    const current = getAttempt();
    if (!writable || current.pending || current.notice === "uncertain" || !live) return;
    setAttempt({
      ...(current.receipt ? { receipt: current.receipt } : {}),
      ids: saved && !blank ? [...saved.selection.selectedDeviceIds] : [],
      reason: "",
      expectedRevision: revision,
      boundaryKey: live.boundary.key,
    });
  };
  const run = async () => {
    const current = getAttempt();
    if (!writable || current.pending) return;
    if (!current.request && (!live || !editable || invalid || !current.reason.trim())) return;
    const request =
      current.request ??
      (live
        ? {
            requestId: createRequestId(),
            boundaryKey: live.boundary.key,
            selectedDeviceIds: [...current.ids],
            expectedRevision: current.expectedRevision ?? revision,
            reason: current.reason.trim(),
          }
        : undefined);
    const original = current.observation ?? live;
    if (!request || !original) return;
    const next: DeviceRetentionAttempt = {
      ...current,
      request,
      observation: original,
      pending: true,
    };
    setAttempt(next);
    try {
      if (current.preview) {
        const receipt = await requestConfirm(
          { requestId: request.requestId, previewId: current.preview.id },
          current.preview,
        );
        setAttempt({ ...emptyDeviceRetentionAttempt, receipt });
        await refresh();
      } else {
        const preview = await requestPreview(request);
        setAttempt({
          ...(current.receipt ? { receipt: current.receipt } : {}),
          ids: current.ids,
          reason: current.reason,
          expectedRevision: request.expectedRevision,
          boundaryKey: request.boundaryKey,
          request,
          preview,
          observation: preview.observation,
        });
      }
    } catch (error) {
      const notice = classifyError(error);
      if (notice === "uncertain") setAttempt({ ...next, pending: false, notice });
      else {
        setAttempt({
          ...(current.receipt ? { receipt: current.receipt } : {}),
          ids: current.ids,
          reason: current.reason,
          notice,
          ...(current.expectedRevision === undefined
            ? {}
            : { expectedRevision: current.expectedRevision }),
          ...(current.boundaryKey === undefined ? {} : { boundaryKey: current.boundaryKey }),
        });
        await refresh();
      }
    }
  };
  return (
    <Card
      title={t("deviceRetention.title")}
      titleAs="h2"
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <p>{t("deviceRetention.intro")}</p>
      <Alert tone="warn">{t("deviceRetention.shadowOnly")}</Alert>
      {inspection.isPending ? <p role="status">{t("deviceRetention.loading")}</p> : null}
      {inspection.isError ? <Alert tone="error">{t("deviceRetention.loadError")}</Alert> : null}
      {inspection.data && !writable ? <p>{t("deviceRetention.readonly")}</p> : null}
      {inspection.data?.currentShadow.awaitingSelection ||
      inspection.data?.currentShadow.affectedDeviceIds.length ? (
        <Alert tone="warn">
          {t("deviceRetention.currentShadow", {
            count: inspection.data.currentShadow.affectedDeviceIds.length,
          })}
        </Alert>
      ) : null}
      {inspection.data?.currentShadow.awaitingSelection ? (
        <Alert tone="warn">{t("deviceRetention.awaitingSelection")}</Alert>
      ) : null}
      {!live && !locked && inspection.data ? <p>{t("deviceRetention.noBoundary")}</p> : null}
      {attempt.receipt ? (
        <section aria-label={t("deviceRetention.receipt")}>
          <Alert tone="ok">
            {t("deviceRetention.saved", {
              at: date(attempt.receipt.selection.observation.boundary.effectiveAt),
            })}
          </Alert>
          <Selected
            translate={t}
            observation={attempt.receipt.selection.observation}
            ids={attempt.receipt.selection.selectedDeviceIds}
          />
          <details>
            <summary>{t("deviceRetention.originalFacts")}</summary>
            <Observation {...view} observation={attempt.receipt.selection.observation} historical />
          </details>
        </section>
      ) : null}
      {observation ? (
        <section style={{ display: "grid", gap: "var(--sp-3)", marginBlock: "var(--sp-4)" }}>
          <Observation {...view} observation={observation} />
          {stale || invalid ? <Alert tone="warn">{t("deviceRetention.needsReview")}</Alert> : null}
          {!saved || attempt.expectedRevision !== undefined || locked ? (
            <>
              <p>{t("deviceRetention.count", { count: attempt.ids.length })}</p>
              <fieldset
                disabled={!editable}
                style={{ display: "grid", gap: "var(--sp-3)", border: 0, padding: 0, margin: 0 }}
              >
                <legend>{t("deviceRetention.choose")}</legend>
                {observation.devices.map((device) => (
                  <div key={device.deviceId}>
                    <Checkbox
                      label={device.name}
                      checked={attempt.ids.includes(device.deviceId)}
                      disabled={!device.eligible || !editable}
                      onCheckedChange={(checked) =>
                        edit(
                          checked
                            ? [...attempt.ids, device.deviceId]
                            : attempt.ids.filter((id) => id !== device.deviceId),
                          attempt.reason,
                        )
                      }
                    />
                    <p>
                      {t(`deviceReplacement.kind.${device.kind}`)} ·{" "}
                      {t(`deviceRetention.state.${device.state}`)}
                    </p>
                    <p>{t("deviceReplacement.serverWork", device.knownServerWork)}</p>
                    {device.reasons.map((reason) => (
                      <p key={reason}>{t(`deviceRetention.ineligible.${reason}`)}</p>
                    ))}
                  </div>
                ))}
                <Input
                  label={t("deviceRetention.reason")}
                  value={attempt.reason}
                  maxLength={1000}
                  onChange={(event) => edit(attempt.ids, event.target.value)}
                />
              </fieldset>
            </>
          ) : null}
          {attempt.preview ? (
            <section aria-label={t("deviceRetention.previewSummary")}>
              <p>{t("deviceRetention.expires", { at: date(attempt.preview.expiresAt) })}</p>
              <Selected
                translate={t}
                observation={attempt.preview.observation}
                ids={attempt.preview.selectedDeviceIds}
              />
            </section>
          ) : null}
        </section>
      ) : null}
      {attempt.notice ? (
        <Alert tone={attempt.notice === "conflict" ? "warn" : "error"}>
          {t(`deviceRetention.${attempt.notice}`)}
        </Alert>
      ) : null}
      {writable && (observation || attempt.request) ? (
        <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap" }}>
          {(saved && attempt.expectedRevision === undefined) || stale || invalid ? (
            <Button variant="secondary" disabled={locked || !live} onClick={() => begin()}>
              {t(saved ? "deviceRetention.edit" : "deviceRetention.restart")}
            </Button>
          ) : null}
          {live && (saved || attempt.expectedRevision !== undefined) ? (
            <Button variant="secondary" disabled={locked} onClick={() => begin(true)}>
              {t("deviceRetention.blank")}
            </Button>
          ) : null}
          {attempt.notice === "uncertain" ||
          (!stale && (!saved || attempt.expectedRevision !== undefined)) ? (
            <Button
              disabled={
                attempt.pending ||
                (attempt.notice !== "uncertain" && (!attempt.reason.trim() || invalid))
              }
              onClick={() => void run()}
            >
              {t(
                attempt.notice === "uncertain"
                  ? "deviceRetention.retry"
                  : attempt.preview
                    ? "deviceRetention.save"
                    : "deviceRetention.preview",
              )}
            </Button>
          ) : null}
        </div>
      ) : null}
      {inspection.data?.selections.map((item) => (
        <section
          key={item.selection.id}
          aria-label={t("deviceRetention.history")}
          style={{ marginBlock: "var(--sp-4)" }}
        >
          <p>
            {t("deviceRetention.saved", {
              at: date(item.selection.observation.boundary.effectiveAt),
            })}
          </p>
          <p>
            {t("deviceRetention.revision", {
              revision: item.selection.revision,
              at: date(item.selection.preparedAt),
            })}
          </p>
          {item.needsReview ? <Alert tone="warn">{t("deviceRetention.needsReview")}</Alert> : null}
          {item.boundaryReached ? <Alert tone="warn">{t("deviceRetention.reached")}</Alert> : null}
          <Selected
            translate={t}
            observation={item.selection.observation}
            ids={item.selection.selectedDeviceIds}
          />
          <details>
            <summary>{t("deviceRetention.originalFacts")}</summary>
            <Observation {...view} observation={item.selection.observation} historical />
          </details>
        </section>
      ))}
    </Card>
  );
}
function Selected({
  observation,
  ids,
  translate: t,
}: {
  observation: DeviceRetentionObservation;
  ids: string[];
  translate: DeviceRetentionTranslate;
}) {
  return (
    <>
      <p>{t("deviceRetention.count", { count: ids.length })}</p>
      <ul>
        {ids.map((id) => (
          <li key={id}>
            {observation.devices.find((device) => device.deviceId === id)?.name ?? id}
          </li>
        ))}
      </ul>
    </>
  );
}
function Observation({
  observation: o,
  historical = false,
  translate: t,
  language,
  renderSnapshot,
}: {
  observation: DeviceRetentionObservation;
  historical?: boolean;
  translate: DeviceRetentionTranslate;
  language: string;
  renderSnapshot: (snapshot: EntitlementSnapshotV1) => ReactNode;
}) {
  const limit = o.future.candidate.quotas.stations.limit;
  return (
    <div style={{ display: "grid", gap: "var(--sp-2)" }}>
      <p>
        {t("deviceRetention.boundary", {
          at: new Intl.DateTimeFormat(language, {
            dateStyle: "medium",
            timeStyle: "long",
            timeZone: "Europe/Moscow",
          }).format(new Date(o.boundary.effectiveAt)),
        })}
      </p>
      <p>
        {t(limit === null ? "deviceRetention.unlimited" : "deviceRetention.capacity", {
          limit,
          used: o.current.candidate.quotas.stations.used,
        })}
      </p>
      <p>
        {t(
          o.future.candidate.features.handheld === true
            ? "deviceRetention.handheldIncluded"
            : "deviceRetention.handheldNotIncluded",
        )}
      </p>
      <Alert tone="warn">{t("deviceReplacement.localUnknown")}</Alert>
      {historical ? (
        <ul>
          {o.devices.map((device) => (
            <li key={device.deviceId}>
              {device.name} · {t(`deviceReplacement.kind.${device.kind}`)} ·{" "}
              {t(`deviceRetention.state.${device.state}`)}
              <p>{t("deviceReplacement.serverWork", device.knownServerWork)}</p>
              {device.reasons.map((reason) => (
                <p key={reason}>{t(`deviceRetention.ineligible.${reason}`)}</p>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      <details>
        <summary>{t("deviceRetention.futureFacts")}</summary>
        {renderSnapshot(o.future)}
      </details>
      {o.services.length ? (
        <>
          <p>{t("deviceRetention.services")}</p>
          <ul>
            {o.services.map((service) => (
              <li key={service.id}>
                {language.startsWith("ru") ? service.nameRu : service.nameEn} · {service.quantity}{" "}
                {service.unit} · {t(`deviceRetention.serviceStatus.${service.status}`)}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <ul>
        {o.execution.reasons.map((reason) => (
          <li key={reason}>{t(`deviceRetention.execution.${reason}`)}</li>
        ))}
      </ul>
    </div>
  );
}
