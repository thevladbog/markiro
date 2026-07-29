import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { Alert, Button, Card, Input, PageHeader, Spinner, StatusChip } from "@markiro/ui";
import type { StatusChipStatus } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import { JournalList } from "./JournalList.js";
import {
  useChannelDetail,
  useIssueCredentials,
  useUpdateChannelSettings,
  type ChannelDetailDto,
  type ChannelState,
  type CredentialsIssuedDto,
} from "./api.js";

/** Same map as `pages/integrations/index.tsx`'s `ChannelCard` -- kept local rather than shared, since this page's header draws it once, not per card in a grid. */
const STATE_STATUS: Record<ChannelState, StatusChipStatus> = {
  working: "ok",
  error: "error",
  silent: "warn",
  not_configured: "neutral",
  unavailable: "info",
};

interface CommercemlSettingsValues {
  priceType: string;
  splitWriteoffDocument: boolean;
}

/**
 * CommerceML's own settings form -- `priceType` and `splitWriteoffDocument`,
 * mirroring `apps/api/src/modules/integrations/channel-registry.ts`'s
 * `commercemlSettings` schema. `splitWriteoffDocument` is saved here but only
 * consumed by plan I-2 (per the task brief) -- this task's job is just to
 * persist it, not to act on it.
 */
function CommercemlSettingsForm({
  channel,
  onSave,
  saving,
}: {
  channel: ChannelDetailDto;
  onSave: (patch: Record<string, unknown>) => void | Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const { register, handleSubmit } = useForm<CommercemlSettingsValues>({
    defaultValues: {
      priceType:
        typeof channel.settings["priceType"] === "string" ? channel.settings["priceType"] : "",
      splitWriteoffDocument: Boolean(channel.settings["splitWriteoffDocument"]),
    },
  });

  const submit = handleSubmit(async (values) => {
    const priceType = values.priceType.trim();
    await onSave({
      ...(priceType ? { priceType } : {}),
      splitWriteoffDocument: values.splitWriteoffDocument,
    });
  });

  return (
    <form
      onSubmit={(event) => void submit(event)}
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      <Input
        label={t("pages.integrations.channel.settings.priceTypeLabel")}
        hint={t("pages.integrations.channel.settings.priceTypeHint")}
        {...register("priceType")}
      />
      <label style={{ display: "flex", alignItems: "center", gap: 8, font: "var(--text-body)" }}>
        <input type="checkbox" {...register("splitWriteoffDocument")} />
        {t("pages.integrations.channel.settings.splitWriteoffDocumentLabel")}
      </label>
      <div>
        <Button type="submit" loading={saving}>
          {t("pages.integrations.channel.settings.saveAction")}
        </Button>
      </div>
    </form>
  );
}

/**
 * The channel page's credentials sub-section -- the exchange login/secret
 * pair for an inbound channel. Brief 08's channel page spec ("For an
 * exchange this includes its credentials; a secret is shown once on
 * creation and never again, matching the device-pairing pattern in brief
 * 07"): the freshly issued secret lives only in `issued` (this component's
 * own transient state, cleared on unmount), never in the query cache and
 * never refetched. While `issued` is set, the persisted-login line is
 * hidden in favor of the one-time reveal panel below -- showing both at once
 * would render the login text twice, which is redundant, not just noisy.
 */
function CredentialsSection({
  channel,
  onIssue,
  issuing,
  issued,
}: {
  channel: ChannelDetailDto;
  onIssue: () => void;
  issuing: boolean;
  issued: CredentialsIssuedDto | null;
}) {
  const { t } = useTranslation();

  return (
    <div
      style={{
        marginTop: 20,
        paddingTop: 16,
        borderTop: "1px solid var(--line)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <span style={{ font: "600 14px/20px var(--font-ui)", color: "var(--fg-1)" }}>
        {t("pages.integrations.channel.credentials.title")}
      </span>

      {!issued && (
        <span style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
          {channel.credentialLogin
            ? t("pages.integrations.channel.credentials.loginValue", {
                login: channel.credentialLogin,
              })
            : t("pages.integrations.channel.credentials.notIssued")}
        </span>
      )}

      <div>
        <Button type="button" variant="secondary" loading={issuing} onClick={onIssue}>
          {t("pages.integrations.channel.credentials.issueAction")}
        </Button>
      </div>

      {issued && (
        <Alert tone="warn" title={t("pages.integrations.channel.credentials.issuedTitle")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span>
              {t("pages.integrations.channel.credentials.issuedLogin", { login: issued.login })}
            </span>
            <span style={{ font: "var(--text-code)" }}>
              {t("pages.integrations.channel.credentials.issuedSecret", {
                secret: issued.secret,
              })}
            </span>
            <strong>{t("pages.integrations.channel.credentials.issuedWarning")}</strong>
          </div>
        </Alert>
      )}
    </div>
  );
}

/**
 * Admin channel page -- Plan I-1 Task 13. One page per channel, three clean
 * regions per brief 08 ("Channel page"): header (identity/state/last event),
 * settings (the channel's own form plus its exchange credentials), and
 * journal (`JournalList`). Kept as three visually separate `Card`s rather
 * than one merged block deliberately -- the candidates queue and the public
 * API keys panel that later tasks add both slot in as additional areas on
 * this same page, and that only stays simple if today's three regions never
 * fused into one.
 */
export function ChannelPage() {
  const { type: typeParam } = useParams<{ type: string }>();
  const type = typeParam ?? "";
  const { t, i18n } = useTranslation();

  const { data: channel, isPending, isError } = useChannelDetail(type);
  const updateSettings = useUpdateChannelSettings(type);
  const issueCredentials = useIssueCredentials(type);

  const [issued, setIssued] = useState<CredentialsIssuedDto | null>(null);

  const handleSaveSettings = async (patch: Record<string, unknown>) => {
    try {
      await updateSettings.mutateAsync(patch);
      toast("ok", t("pages.integrations.channel.settings.saveSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.settings.saveError"),
      );
    }
  };

  const handleIssueCredentials = async () => {
    try {
      const data = await issueCredentials.mutateAsync();
      setIssued(data);
      toast("ok", t("pages.integrations.channel.credentials.issueSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.credentials.issueError"),
      );
    }
  };

  if (isPending) {
    return (
      <div style={{ padding: "28px 32px", display: "flex", justifyContent: "center" }}>
        <Spinner label={t("common.loading")} />
      </div>
    );
  }

  if (isError || !channel) {
    return (
      <div style={{ padding: "28px 32px" }}>
        <Alert tone="error">{t("pages.integrations.channel.loadError")}</Alert>
      </div>
    );
  }

  return (
    <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
      <Link
        to="/integrations"
        style={{ font: "var(--text-body)", color: "var(--fg-3)", textDecoration: "none" }}
      >
        {t("pages.integrations.channel.backAction")}
      </Link>

      <PageHeader
        title={t(channel.labelKey)}
        actions={
          <StatusChip
            status={STATE_STATUS[channel.state]}
            label={t(`integrations.state.${channel.state}`)}
          />
        }
      />

      <Card>
        <span style={{ font: "var(--text-body)", color: "var(--fg-2)" }}>
          {channel.lastEventAt
            ? t("integrations.lastEvent", {
                time: new Intl.DateTimeFormat(i18n.language, {
                  dateStyle: "short",
                  timeStyle: "short",
                }).format(new Date(channel.lastEventAt)),
              })
            : t("pages.integrations.channel.neverEvent")}
        </span>
      </Card>

      <Card title={t("pages.integrations.channel.settings.title")}>
        {channel.type === "commerceml" ? (
          <CommercemlSettingsForm
            channel={channel}
            onSave={handleSaveSettings}
            saving={updateSettings.isPending}
          />
        ) : (
          <p style={{ font: "var(--text-body)", color: "var(--fg-3)" }}>
            {t("pages.integrations.channel.settings.noSettings")}
          </p>
        )}

        <CredentialsSection
          channel={channel}
          onIssue={() => void handleIssueCredentials()}
          issuing={issueCredentials.isPending}
          issued={issued}
        />
      </Card>

      <JournalList type={type} />
    </div>
  );
}
