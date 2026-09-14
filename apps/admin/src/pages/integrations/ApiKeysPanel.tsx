import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Input,
  Modal,
  Spinner,
  Table,
} from "@markiro/ui";
import type { TableColumn } from "@markiro/ui";
import { PUBLIC_API_SCOPES, type PublicApiScope } from "@markiro/platform-contracts";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import {
  useApiKeys,
  useIssueApiKey,
  useRevokeApiKey,
  useUpdateApiKeyScopes,
  type ApiKeyIssuedDto,
  type ApiKeySummaryDto,
} from "./api.js";

const SCOPE_I18N_KEY: Record<PublicApiScope, string> = {
  "catalog.products.read": "scopeCatalogProductsRead",
  "inventory.read": "scopeInventoryRead",
  "inventory.prepare": "scopeInventoryPrepare",
  "inventory.start": "scopeInventoryStart",
};

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
  const [issueScopes, setIssueScopes] = useState<PublicApiScope[]>([]);
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<ApiKeyIssuedDto | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeySummaryDto | null>(null);
  const [editTarget, setEditTarget] = useState<ApiKeySummaryDto | null>(null);
  const [editScopes, setEditScopes] = useState<PublicApiScope[]>([]);

  const { issue } = useIssueApiKey();
  const revokeKey = useRevokeApiKey();
  const updateScopes = useUpdateApiKeyScopes();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }),
    [i18n.language],
  );

  const handleIssue = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setIssued(null);
    setIssuing(true);
    try {
      const data = await issue(trimmed, issueScopes);
      setIssued(data);
      setName("");
      setIssueScopes([]);
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

  const handleScopeUpdate = async () => {
    if (!editTarget) return;
    try {
      await updateScopes.mutateAsync({ id: editTarget.id, scopes: editScopes });
      toast("ok", t("pages.integrations.channel.apiKeys.scopeEditSuccess"));
      setEditTarget(null);
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.apiKeys.scopeEditError"),
      );
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
        key: "scopes",
        title: t("pages.integrations.channel.apiKeys.table.scopes"),
        render: (row) =>
          row.scopes.length ? (
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {row.scopes.map((scope) => (
                <li key={scope}>
                  {t(`pages.integrations.channel.apiKeys.${SCOPE_I18N_KEY[scope]}`)}
                </li>
              ))}
            </ul>
          ) : (
            <span style={{ whiteSpace: "normal", color: "var(--warn-fg)" }}>
              {t("pages.integrations.channel.apiKeys.legacyUnscoped")}
            </span>
          ),
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
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button
              type="button"
              size="compact"
              variant="secondary"
              onClick={() => {
                setEditTarget(row);
                setEditScopes([...row.scopes]);
              }}
            >
              {t("pages.integrations.channel.apiKeys.scopeEditAction")}
            </Button>
            <Button
              type="button"
              size="compact"
              variant="destructive"
              onClick={() => setRevokeTarget(row)}
            >
              {t("pages.integrations.channel.apiKeys.revokeAction")}
            </Button>
          </div>
        ),
      },
    ],
    [t, dateFormatter],
  );

  return (
    <Card title={t("pages.integrations.channel.apiKeys.title")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "grid", gap: 12 }}>
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
          <ScopeSelector scopes={issueScopes} onChange={setIssueScopes} />
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
      <Modal
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        closeLabel={t("common.close")}
        title={t("pages.integrations.channel.apiKeys.scopeEditTitle")}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setEditTarget(null)}>
              {t("pages.integrations.channel.apiKeys.cancel")}
            </Button>
            <Button
              type="button"
              loading={updateScopes.isPending}
              onClick={() => void handleScopeUpdate()}
            >
              {t("pages.integrations.channel.apiKeys.scopeEditSave")}
            </Button>
          </>
        }
      >
        <ScopeSelector scopes={editScopes} onChange={setEditScopes} />
      </Modal>
    </Card>
  );
}

function ScopeSelector({
  scopes,
  onChange,
}: {
  scopes: PublicApiScope[];
  onChange: (scopes: PublicApiScope[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
      <legend style={{ marginBottom: 8 }}>
        {t("pages.integrations.channel.apiKeys.scopesLabel")}
      </legend>
      {PUBLIC_API_SCOPES.map((scope) => (
        <Checkbox
          key={scope}
          label={t(`pages.integrations.channel.apiKeys.${SCOPE_I18N_KEY[scope]}`)}
          checked={scopes.includes(scope)}
          onCheckedChange={(checked) =>
            onChange(checked ? [...scopes, scope] : scopes.filter((item) => item !== scope))
          }
        />
      ))}
    </fieldset>
  );
}
