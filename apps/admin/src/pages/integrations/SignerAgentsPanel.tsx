import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import type { StatusChipStatus, TableColumn } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import {
  issueSignerPairingCode,
  requestSignerTokenRefresh,
  useChzCodeStatusSummary,
  useRevokeSignerAgent,
  useSignerAgents,
  type SignerAgent,
  type SignerAgentStatus,
  type SignerPairingCodeResult,
  type SignerTokenStatus,
  type SignerTokenRefreshResult,
} from "./api.js";
import { SignerDownloadLink } from "./SignerDownloadLink.js";

const TOKEN_CHIP_STATUS: Record<SignerTokenStatus["status"], StatusChipStatus> = {
  none: "neutral",
  active: "ok",
  expiring: "warn",
  expired: "error",
};

const AGENT_CHIP_STATUS: Record<SignerAgentStatus, StatusChipStatus> = {
  active: "ok",
  revoked: "neutral",
};

/**
 * The `chestny_znak` channel's own panel -- Task 8 (see the design brief
 * under `.superpowers/sdd`). Unlike `ApiKeysPanel` (fully gated behind
 * `CREDENTIALS_MANAGE`, because that panel's whole content *is* credential
 * data), the agent list itself is not secret -- the server's own `GET
 * /signer-agents` only requires `INTEGRATIONS_READ` (`SignerAgentsController`'s
 * `overview` route), the same capability the `/integrations/:type` route
 * itself is already gated on (`app.tsx`'s `RequireCapability`) -- so anyone
 * who reached this page at all can see it. Only the two mutating actions
 * (issuing a pairing code, revoking an agent) need the stricter pair the
 * controller requires there: `INTEGRATIONS_WRITE` *and* `CREDENTIALS_MANAGE`
 * together, mirroring `ChannelPage.tsx`'s own `canIssueCredentials`.
 *
 * Self-contained like `ApiKeysPanel`/`CandidatesQueue`: fetches its own
 * overview and owns its own issue/revoke calls rather than taking them as
 * props from `ChannelPage`.
 */
export function SignerAgentsPanel() {
  const { t, i18n } = useTranslation();
  const { data, isPending, isError, refetch } = useSignerAgents();
  const { data: codeStatuses, isError: isCodeStatusesError } = useChzCodeStatusSummary();
  const canWriteIntegrations = useCan(CABINET_CAPABILITY.INTEGRATIONS_WRITE);
  const canManageCredentials = useCan(CABINET_CAPABILITY.CREDENTIALS_MANAGE);
  const canManage = canWriteIntegrations && canManageCredentials;
  const revoke = useRevokeSignerAgent();

  const [code, setCode] = useState<SignerPairingCodeResult | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRequest, setRefreshRequest] = useState<{
    taskId: string;
    result: SignerTokenRefreshResult["status"];
    previousObtainedAt: string | null;
  } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<SignerAgent | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }),
    [i18n.language],
  );

  const hasActiveAgent = data?.agents.some((agent) => agent.status === "active") ?? false;
  const refreshTaskOpen =
    data?.refreshTask?.status === "pending" || data?.refreshTask?.status === "claimed";
  const refreshTaskFailure =
    data?.refreshTask?.status === "failed" || data?.refreshTask?.status === "expired"
      ? data.refreshTask.errorMessage ||
        t(`pages.integrations.channel.signer.task.${data.refreshTask.status}`)
      : null;

  useEffect(() => {
    if (!refreshRequest && !refreshTaskOpen) return;
    const timer = window.setInterval(() => {
      void refetch().then((response) => {
        if (!refreshRequest) return;
        const obtainedAt = response.data?.token.obtainedAt ?? null;
        const task = response.data?.refreshTask;
        if (
          task?.id === refreshRequest.taskId &&
          (task.status === "failed" || task.status === "expired")
        ) {
          setRefreshRequest(null);
          return;
        }
        if (task?.id === refreshRequest.taskId && task.status === "completed") {
          setRefreshRequest(null);
          toast("ok", t("pages.integrations.channel.signer.refreshComplete"));
          return;
        }
        if (obtainedAt && obtainedAt !== refreshRequest.previousObtainedAt) {
          setRefreshRequest(null);
          toast("ok", t("pages.integrations.channel.signer.refreshComplete"));
        }
      });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [refetch, refreshRequest, refreshTaskOpen, t]);

  const handleIssue = async () => {
    setIssuing(true);
    try {
      const result = await issueSignerPairingCode();
      setCopyError(false);
      setCode(result);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.signer.issueError"),
      );
    } finally {
      setIssuing(false);
    }
  };

  const handleCopy = async () => {
    if (!code) return;
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(code.code);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };

  const handleRefreshToken = async () => {
    setRefreshing(true);
    try {
      const result = await requestSignerTokenRefresh();
      setRefreshRequest({
        taskId: result.taskId,
        result: result.status,
        previousObtainedAt: data?.token.obtainedAt ?? null,
      });
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.signer.refreshError"),
      );
    } finally {
      setRefreshing(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setRevokeError(null);
    try {
      await revoke.mutateAsync(revokeTarget.id);
      toast("ok", t("pages.integrations.channel.signer.revokeSuccess"));
      setRevokeTarget(null);
    } catch (error) {
      setRevokeError(
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.signer.revokeError"),
      );
    }
  };

  const columns: TableColumn<SignerAgent>[] = useMemo(
    () => [
      {
        key: "name",
        title: t("pages.integrations.channel.signer.columns.name"),
        render: (agent) => agent.name,
      },
      {
        key: "status",
        title: t("pages.integrations.channel.signer.columns.status"),
        render: (agent) => (
          <StatusChip
            status={AGENT_CHIP_STATUS[agent.status]}
            label={t(`pages.integrations.channel.signer.status.${agent.status}`)}
          />
        ),
      },
      {
        key: "cert",
        title: t("pages.integrations.channel.signer.columns.cert"),
        render: (agent) => agent.certSubject ?? agent.certThumbprint ?? "—",
      },
      {
        key: "lastSeen",
        title: t("pages.integrations.channel.signer.columns.lastSeen"),
        render: (agent) =>
          agent.lastSeenAt ? dateFormatter.format(new Date(agent.lastSeenAt)) : "—",
      },
      ...(canManage
        ? [
            {
              key: "actions",
              title: "",
              align: "right" as const,
              render: (agent: SignerAgent) =>
                agent.status === "active" ? (
                  <Button
                    type="button"
                    size="compact"
                    variant="destructive"
                    onClick={() => setRevokeTarget(agent)}
                  >
                    {t("pages.integrations.channel.signer.revoke")}
                  </Button>
                ) : null,
            },
          ]
        : []),
    ],
    [t, dateFormatter, canManage],
  );

  return (
    <Card title={t("pages.integrations.channel.signer.title")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: "var(--sp-2)",
            padding: "var(--sp-3)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-2)",
            background: "var(--surface-panel)",
          }}
        >
          <p style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--fg-2)" }}>
            {t("pages.integrations.channel.signer.downloadHint")}
          </p>
          <SignerDownloadLink
            data-analytics="signer_download_click"
            data-placement="chestny-znak-signer"
          >
            {t("pages.integrations.channel.signer.downloadAction")}
          </SignerDownloadLink>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "var(--sp-3)",
            flexWrap: "wrap",
            padding: "var(--sp-3)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-2)",
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
              {t("pages.integrations.channel.signer.tokenLabel")}
            </span>
            {data ? (
              <StatusChip
                status={TOKEN_CHIP_STATUS[data.token.status]}
                label={t(`pages.integrations.channel.signer.token.${data.token.status}`)}
              />
            ) : null}
            {data?.token.expiresAt ? (
              <span style={{ font: "var(--text-body)", color: "var(--fg-3)" }}>
                {t("pages.integrations.channel.signer.tokenExpires", {
                  at: dateFormatter.format(new Date(data.token.expiresAt)),
                })}
              </span>
            ) : null}
          </div>
          {canManage && hasActiveAgent ? (
            <Button
              type="button"
              variant="secondary"
              loading={refreshing || refreshRequest !== null || refreshTaskOpen}
              onClick={() => void handleRefreshToken()}
            >
              {t("pages.integrations.channel.signer.refreshToken")}
            </Button>
          ) : null}
        </div>

        {refreshRequest || refreshTaskOpen ? (
          <Alert tone="info">
            {t(
              `pages.integrations.channel.signer.refresh.${refreshRequest?.result ?? "already_pending"}`,
            )}
          </Alert>
        ) : null}

        {refreshTaskFailure ? <Alert tone="error">{refreshTaskFailure}</Alert> : null}

        {canManage ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <Button type="button" loading={issuing} onClick={() => void handleIssue()}>
                {t("pages.integrations.channel.signer.issueCode")}
              </Button>
            </div>
            {code ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--sp-3)",
                  padding: "var(--sp-4)",
                  border: "1px solid var(--line-strong)",
                  borderRadius: "var(--r-2)",
                  background: "var(--surface-panel)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "var(--sp-3)",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
                      {t("pages.integrations.channel.signer.codeLabel")}
                    </span>
                    <span
                      style={{
                        font: "var(--text-code)",
                        fontSize: 22,
                        letterSpacing: "0.12em",
                        fontVariantNumeric: "tabular-nums",
                      }}
                      data-testid="signer-pairing-code"
                    >
                      {code.code}
                    </span>
                  </div>
                  <Button type="button" variant="secondary" onClick={() => void handleCopy()}>
                    {t("pages.integrations.channel.signer.copyCode")}
                  </Button>
                </div>
                <span style={{ font: "var(--text-body-sm)", color: "var(--fg-3)" }}>
                  {t("pages.integrations.channel.signer.codeExpires", {
                    at: dateFormatter.format(new Date(code.expiresAt)),
                  })}
                </span>
                {copyError ? (
                  <Alert tone="error">{t("pages.integrations.channel.signer.copyError")}</Alert>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {isPending ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
            <Spinner label={t("common.loading")} />
          </div>
        ) : isError ? (
          <Alert tone="error">{t("pages.integrations.channel.signer.loadError")}</Alert>
        ) : data && data.agents.length === 0 ? (
          <EmptyState
            title={t("pages.integrations.channel.signer.emptyTitle")}
            hint={t("pages.integrations.channel.signer.emptyHint")}
          />
        ) : data ? (
          <Table columns={columns} rows={data.agents} getRowKey={(agent) => agent.id} />
        ) : null}

        {isCodeStatusesError ? (
          <Alert tone="error">{t("pages.integrations.channel.codeStatuses.loadError")}</Alert>
        ) : codeStatuses ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ font: "var(--text-body)", color: "var(--fg-3)" }}>
              {t("pages.integrations.channel.codeStatuses.line", {
                total: codeStatuses.total,
                refreshedLastDay: codeStatuses.refreshedLastDay,
                lastChecked: codeStatuses.lastCheckedAt
                  ? t("pages.integrations.channel.codeStatuses.lastCheckedAt", {
                      at: dateFormatter.format(new Date(codeStatuses.lastCheckedAt)),
                    })
                  : t("pages.integrations.channel.codeStatuses.neverChecked"),
              })}
            </span>
            {codeStatuses.withoutProductGroup > 0 ? (
              <Alert tone="warn">
                {t("pages.integrations.channel.codeStatuses.withoutProductGroup", {
                  count: codeStatuses.withoutProductGroup,
                })}
              </Alert>
            ) : null}
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={revokeTarget !== null}
        tone="destructive"
        title={t("pages.integrations.channel.signer.revokeConfirmTitle")}
        description={t("pages.integrations.channel.signer.revokeConfirmBody")}
        entity={revokeTarget?.name ?? ""}
        error={revokeError}
        confirmLabel={t("pages.integrations.channel.signer.revoke")}
        cancelLabel={t("pages.integrations.channel.signer.cancel")}
        busy={revoke.isPending}
        onConfirm={() => void handleRevoke()}
        onCancel={() => {
          if (!revoke.isPending) {
            setRevokeTarget(null);
            setRevokeError(null);
          }
        }}
      />
    </Card>
  );
}
