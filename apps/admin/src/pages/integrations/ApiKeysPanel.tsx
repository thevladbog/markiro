import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, EmptyState, Input, Modal, Spinner, Table } from "@markiro/ui";
import type { TableColumn } from "@markiro/ui";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import {
  useApiKeys,
  useIssueApiKey,
  useRevokeApiKey,
  type ApiKeyIssuedDto,
  type ApiKeySummaryDto,
} from "./api.js";

/**
 * The `public_api` channel's own panel -- Task 15. This channel has no
 * schedule of its own (brief 08: public API keys are a channel without a
 * schedule): its "settings" are the list of keys below, its "journal" is
 * issuance and revocation, both already appended server-side into the same
 * `JournalList` this page mounts alongside this panel
 * (`api-keys.service.ts`'s `create`/`revoke`). Kept as its own `Card`,
 * mounted next to (never merged into) `ChannelPage`'s generic settings card
 * and `JournalList` -- the same "separate area" discipline `CandidatesQueue`
 * already follows on this same page.
 *
 * Self-contained like `CandidatesQueue`/`CredentialsSection`: fetches its
 * own list and owns its own issue/revoke calls rather than taking them as
 * props from `ChannelPage`.
 */
export function ApiKeysPanel() {
  const canManageCredentials = useCan(CABINET_CAPABILITY.CREDENTIALS_MANAGE);
  return canManageCredentials ? <AuthorizedApiKeysPanel /> : <RestrictedApiKeysPanel />;
}

function RestrictedApiKeysPanel() {
  const { t } = useTranslation();
  return (
    <Card title={t("pages.integrations.channel.apiKeys.title")}>
      <p style={{ margin: 0, font: "var(--text-body)", color: "var(--fg-3)" }}>
        {t("access.forbiddenBody")}
      </p>
    </Card>
  );
}

function AuthorizedApiKeysPanel() {
  const { t, i18n } = useTranslation();
  const { data, isPending, isError } = useApiKeys();
  const keys = useMemo(() => data ?? [], [data]);

  const [name, setName] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<ApiKeyIssuedDto | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeySummaryDto | null>(null);

  const { issue } = useIssueApiKey();
  const revokeKey = useRevokeApiKey();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }),
    [i18n.language],
  );

  const handleIssue = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setIssuing(true);
    try {
      const data = await issue(trimmed);
      setIssued(data);
      setName("");
      toast("ok", t("pages.integrations.channel.apiKeys.issueSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.apiKeys.issueError"),
      );
    } finally {
      setIssuing(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await revokeKey.mutateAsync(revokeTarget.id);
      toast("ok", t("pages.integrations.channel.apiKeys.revokeSuccess"));
      setRevokeTarget(null);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        // The key was already gone server-side (revoked from another tab,
        // by another admin, or a repeated click racing the first request) --
        // the operator's actual goal ("this key must stop working") is
        // already achieved, so this reads as success, not failure. A raw
        // "Unknown public API key" from the server would be a confusing
        // thing to show for what is, from the operator's point of view, a
        // completed revoke. `useRevokeApiKey`'s own `onError` already
        // invalidated the list for the same reason -- the modal must close
        // here too, or the now-vanished row stays selected behind a dialog
        // that offers to revoke it again with the same result forever.
        toast("ok", t("pages.integrations.channel.apiKeys.revokeAlreadyGone"));
        setRevokeTarget(null);
        return;
      }
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.apiKeys.revokeError"),
      );
    }
  };

  const columns: TableColumn<ApiKeySummaryDto>[] = useMemo(
    () => [
      {
        key: "name",
        title: t("pages.integrations.channel.apiKeys.table.name"),
        render: (row) => row.name ?? "—",
      },
      {
        key: "createdAt",
        title: t("pages.integrations.channel.apiKeys.table.createdAt"),
        render: (row) => dateFormatter.format(new Date(row.createdAt)),
      },
      {
        key: "lastRequest",
        title: t("pages.integrations.channel.apiKeys.table.lastRequest"),
        render: (row) =>
          row.lastRequest
            ? dateFormatter.format(new Date(row.lastRequest))
            : t("pages.integrations.channel.apiKeys.table.neverUsed"),
      },
      {
        key: "actions",
        title: t("pages.integrations.channel.apiKeys.table.actions"),
        align: "right",
        render: (row) => (
          <Button
            type="button"
            size="compact"
            variant="destructive"
            onClick={() => setRevokeTarget(row)}
          >
            {t("pages.integrations.channel.apiKeys.revokeAction")}
          </Button>
        ),
      },
    ],
    [t, dateFormatter],
  );

  return (
    <Card title={t("pages.integrations.channel.apiKeys.title")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Input
            label={t("pages.integrations.channel.apiKeys.nameLabel")}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button
            type="button"
            loading={issuing}
            disabled={!name.trim()}
            onClick={() => void handleIssue()}
          >
            {t("pages.integrations.channel.apiKeys.issueAction")}
          </Button>
        </div>

        {issued && (
          <Alert tone="warn" title={t("pages.integrations.channel.apiKeys.issuedTitle")}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ font: "var(--text-code)" }}>
                {t("pages.integrations.channel.apiKeys.issuedKey", { key: issued.key })}
              </span>
              <strong>{t("pages.integrations.channel.apiKeys.issuedWarning")}</strong>
            </div>
          </Alert>
        )}

        {isPending ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
            <Spinner label={t("common.loading")} />
          </div>
        ) : isError ? (
          <Alert tone="error">{t("pages.integrations.channel.apiKeys.loadError")}</Alert>
        ) : keys.length === 0 ? (
          <EmptyState
            title={t("pages.integrations.channel.apiKeys.emptyTitle")}
            hint={t("pages.integrations.channel.apiKeys.emptyHint")}
          />
        ) : (
          <Table columns={columns} rows={keys} />
        )}
      </div>

      <Modal
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        closeLabel={t("common.close")}
        title={t("pages.integrations.channel.apiKeys.revokeConfirmTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setRevokeTarget(null)}>
              {t("pages.integrations.channel.apiKeys.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={revokeKey.isPending}
              onClick={() => void handleRevoke()}
            >
              {t("pages.integrations.channel.apiKeys.revokeConfirmAction")}
            </Button>
          </>
        }
      >
        {revokeTarget && (
          <p style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
            {t("pages.integrations.channel.apiKeys.revokeConfirmBody", {
              name: revokeTarget.name ?? revokeTarget.id,
            })}
          </p>
        )}
      </Modal>
    </Card>
  );
}
