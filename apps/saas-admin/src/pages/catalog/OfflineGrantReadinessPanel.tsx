import type {
  PlatformGrantReadinessPreviewRequest,
  PlatformGrantReadinessPreviewResponse,
  PlatformGrantReadinessRow,
} from "@markiro/platform-contracts";
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Select,
  Spinner,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { OfflineGrantPolicyDto } from "./api.js";
import {
  listOfflineGrantReadiness,
  previewOfflineGrantReadiness,
} from "./offline-grant-readiness-api.js";

export function OfflineGrantReadinessPanel({
  policies,
  canPreview,
  onDirtyChange,
}: {
  policies: OfflineGrantPolicyDto[];
  canPreview: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const approved = useMemo(
    () => policies.filter((policy) => policy.status === "approved"),
    [policies],
  );
  const [tenantId, setTenantId] = useState("");
  const [deviceKind, setDeviceKind] = useState<"" | "station" | "handheld" | "kiosk">("");
  const [status, setStatus] = useState<"" | "eligible" | "blocked">("");
  const [policyId, setPolicyId] = useState(approved[0]?.id ?? "");
  const [cursor, setCursor] = useState<string | undefined>();
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [intent, setIntent] = useState<PlatformGrantReadinessPreviewRequest | null>(null);
  const [preview, setPreview] = useState<PlatformGrantReadinessPreviewResponse | null>(null);
  const filters = useMemo(
    () => ({
      ...(tenantId ? { tenantId } : {}),
      ...(deviceKind ? { deviceKind } : {}),
      ...(status ? { readiness: status } : {}),
      ...(policyId ? { policyId } : {}),
      limit: 50,
    }),
    [deviceKind, policyId, status, tenantId],
  );
  const readiness = useQuery({
    queryKey: ["platform", "offline-grants", "readiness", filters, cursor ?? null],
    queryFn: () => listOfflineGrantReadiness(filters, cursor),
  });
  const previewMutation = useMutation({
    mutationFn: previewOfflineGrantReadiness,
    onSuccess: (result) => setPreview(result),
  });

  useEffect(
    () => onDirtyChange?.(selected.length > 0 || intent !== null || preview !== null),
    [intent, onDirtyChange, preview, selected.length],
  );
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    setCursor(undefined);
    setCursorHistory([]);
    setSelected([]);
    setIntent(null);
    setPreview(null);
  }, [deviceKind, policyId, status, tenantId]);

  const rows = readiness.data?.items ?? [];
  const changeSelection = (deviceId: string, checked: boolean) => {
    setSelected((current) =>
      checked ? [...current, deviceId] : current.filter((id) => id !== deviceId),
    );
    setIntent(null);
    setPreview(null);
    previewMutation.reset();
  };
  const columns: TableColumn<PlatformGrantReadinessRow>[] = [
    {
      key: "select",
      title: t("catalog.offlineReadiness.columns.select"),
      render: (row) => (
        <Checkbox
          label={t("catalog.offlineReadiness.selectDevice", { name: row.deviceName })}
          checked={selected.includes(row.deviceId)}
          disabled={
            row.eligibility.status !== "eligible" ||
            (!selected.includes(row.deviceId) && selected.length >= 200)
          }
          onCheckedChange={(checked) => changeSelection(row.deviceId, checked)}
        />
      ),
    },
    {
      key: "device",
      title: t("catalog.offlineReadiness.columns.device"),
      render: (row) => (
        <>
          <strong>{row.deviceName}</strong>
          <small>
            {row.tenantName} · {t(`catalog.offlineReadiness.kind.${row.deviceKind}`)}
          </small>
        </>
      ),
    },
    {
      key: "status",
      title: t("catalog.offlineReadiness.columns.status"),
      render: (row) => (
        <StatusChip
          status={row.eligibility.status === "eligible" ? "ok" : "warn"}
          label={t(`catalog.offlineReadiness.status.${row.eligibility.status}`)}
        />
      ),
    },
    {
      key: "client",
      title: t("catalog.offlineReadiness.columns.client"),
      render: (row) =>
        row.clientReport ? (
          <span>
            {row.clientReport.clientBuild} · DB {row.clientReport.storageRevision}
            <br />
            <small>
              {t("catalog.offlineReadiness.reportedAt", {
                value: new Date(row.clientReport.receivedAt).toLocaleString(),
              })}
            </small>
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "serverFacts",
      title: t("catalog.offlineReadiness.columns.serverFacts"),
      render: (row) => (
        <span>
          {t(
            row.assignmentId
              ? "catalog.offlineReadiness.assigned"
              : "catalog.offlineReadiness.unassigned",
          )}
          <br />
          <small>
            {row.lastSeenAt
              ? t("catalog.offlineReadiness.lastSeenAt", {
                  value: new Date(row.lastSeenAt).toLocaleString(),
                })
              : t("catalog.offlineReadiness.neverSeen")}
          </small>
        </span>
      ),
    },
    {
      key: "protocolProof",
      title: t("catalog.offlineReadiness.columns.protocolProof"),
      render: (row) => (
        <span>
          {t("catalog.offlineReadiness.configurationMatch", {
            value: t(
              row.clientReport?.matchesCurrentConfiguration
                ? "catalog.offlineReadiness.yes"
                : "catalog.offlineReadiness.no",
            ),
          })}
          <br />
          {t("catalog.offlineReadiness.keysetMatch", {
            value: t(
              row.clientReport?.keysetRevision &&
                row.clientReport.keysetRevision === row.signing.keysetRevision
                ? "catalog.offlineReadiness.yes"
                : "catalog.offlineReadiness.no",
            ),
          })}
          <br />
          {t("catalog.offlineReadiness.grantMatch", {
            value: t(
              row.clientReport?.verifiedGrantMatched
                ? "catalog.offlineReadiness.yes"
                : "catalog.offlineReadiness.no",
            ),
          })}
        </span>
      ),
    },
    {
      key: "evidence",
      title: t("catalog.offlineReadiness.columns.evidence"),
      render: (row) =>
        t("catalog.offlineReadiness.evidenceCount", { count: row.evidence.acceptedCount }),
    },
    {
      key: "reasons",
      title: t("catalog.offlineReadiness.columns.reasons"),
      render: (row) =>
        row.eligibility.reasons.length
          ? row.eligibility.reasons
              .map((reason) => t(`catalog.offlineReadiness.reasons.${reason}`))
              .join("; ")
          : "—",
    },
  ];

  const runPreview = () => {
    if (!policyId || selected.length === 0) return;
    const request =
      preview === null && intent !== null
        ? intent
        : {
            policyId,
            mode: "strict" as const,
            deviceIds: selected,
            requestId: crypto.randomUUID(),
          };
    setIntent(request);
    previewMutation.mutate(request);
  };
  const reset = () => {
    setSelected([]);
    setIntent(null);
    setPreview(null);
    previewMutation.reset();
  };

  return (
    <div className="catalog-form">
      <Alert tone="info">{t("catalog.offlineReadiness.previewOnly")}</Alert>
      <div className="form-grid form-grid--two">
        <Input
          label={t("catalog.offlineReadiness.tenant")}
          value={tenantId}
          onChange={(event) => setTenantId(event.target.value)}
        />
        <Select<"" | "station" | "handheld" | "kiosk">
          label={t("catalog.offlineReadiness.kindLabel")}
          value={deviceKind}
          onValueChange={setDeviceKind}
          options={(["", "station", "handheld", "kiosk"] as const).map((value) => ({
            value,
            label: t(`catalog.offlineReadiness.kind.${value || "all"}`),
          }))}
        />
        <Select<"" | "eligible" | "blocked">
          label={t("catalog.offlineReadiness.statusLabel")}
          value={status}
          onValueChange={setStatus}
          options={(["", "eligible", "blocked"] as const).map((value) => ({
            value,
            label: t(`catalog.offlineReadiness.status.${value || "all"}`),
          }))}
        />
        <Select
          label={t("catalog.offlineReadiness.policy")}
          value={policyId}
          onValueChange={setPolicyId}
          options={approved.map((policy) => ({
            value: policy.id,
            label: `${policy.policyKey} v${policy.version}`,
          }))}
        />
      </div>
      {readiness.isPending ? <Spinner label={t("catalog.offlineReadiness.loading")} /> : null}
      {readiness.isError ? (
        <Alert tone="error">{t("catalog.offlineReadiness.loadError")}</Alert>
      ) : null}
      {readiness.data ? (
        <Table columns={columns} rows={rows} empty={t("catalog.offlineReadiness.empty")} />
      ) : null}
      <div className="catalog-form__actions">
        {cursorHistory.length > 0 ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              const previous = cursorHistory.at(-1);
              setCursorHistory((history) => history.slice(0, -1));
              setCursor(previous);
            }}
          >
            {t("catalog.offlineReadiness.previous")}
          </Button>
        ) : null}
        {readiness.data?.nextCursor ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setCursorHistory((history) => [...history, cursor]);
              setCursor(readiness.data.nextCursor ?? undefined);
            }}
          >
            {t("catalog.offlineReadiness.next")}
          </Button>
        ) : null}
      </div>
      <div className="catalog-form__actions">
        <Button
          type="button"
          disabled={!canPreview || !policyId || selected.length === 0 || previewMutation.isPending}
          onClick={runPreview}
        >
          {t("catalog.offlineReadiness.preview")}
        </Button>
        {intent || preview ? (
          <Button type="button" variant="secondary" onClick={reset}>
            {t("catalog.offlineReadiness.reset")}
          </Button>
        ) : null}
      </div>
      {!canPreview ? <Alert tone="warn">{t("catalog.offlineReadiness.forbidden")}</Alert> : null}
      {previewMutation.isError ? (
        <Alert tone="error">{t("catalog.offlineReadiness.previewError")}</Alert>
      ) : null}
      {preview ? (
        <section aria-label={t("catalog.offlineReadiness.previewDetails")}>
          <Alert tone={preview.aggregates.blocked === 0 ? "ok" : "warn"}>
            {t("catalog.offlineReadiness.previewResult", {
              eligible: preview.aggregates.eligible,
              blocked: preview.aggregates.blocked,
              asOf: new Date(preview.asOf).toLocaleString(),
              digest: preview.previewDigest,
            })}
          </Alert>
          <Table
            columns={columns.filter((column) => column.key !== "select")}
            rows={preview.items}
            empty={t("catalog.offlineReadiness.empty")}
          />
        </section>
      ) : null}
    </div>
  );
}
