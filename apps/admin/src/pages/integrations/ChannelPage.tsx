import { useEffect, useState } from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";

import { Alert, Button, Card, Input, PageHeader, Select, Spinner, StatusChip } from "@markiro/ui";
import type { StatusChipStatus } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { errorProp } from "../../lib/form-error.js";
import { toast } from "../../lib/toast.js";
import { ApiKeysPanel } from "./ApiKeysPanel.js";
import { CandidatesQueue } from "./CandidatesQueue.js";
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

/** Options for each `statusMapping` row's value dropdown -- `labelKey` (not `label`) because it's an i18n key, translated at render time inside the component (`t(option.labelKey)`), same as every other label in this file. */
const STATUS_MAPPING_OPTIONS: {
  value: "punched" | "writtenoff" | "cancelled";
  labelKey: string;
}[] = [
  { value: "punched", labelKey: "pages.integrations.channel.settings.statusMappingOption.punched" },
  {
    value: "writtenoff",
    labelKey: "pages.integrations.channel.settings.statusMappingOption.writtenoff",
  },
  {
    value: "cancelled",
    labelKey: "pages.integrations.channel.settings.statusMappingOption.cancelled",
  },
];

interface CommercemlSettingsValues {
  priceType: string;
  splitWriteoffDocument: boolean;
  writeoffDocumentType: string;
  orderStatusField: string;
  statusMapping: { key: string; value: "punched" | "writtenoff" | "cancelled" }[];
  silentAfterHours: number;
}

/** Derives `useForm`'s values from the server's `ChannelDetailDto` -- shared by the initial `defaultValues` and by the resync effect below, so both read the same shape the same way. */
function commercemlSettingsValuesOf(channel: ChannelDetailDto): CommercemlSettingsValues {
  const rawMapping = channel.settings["statusMapping"];
  const statusMapping =
    rawMapping && typeof rawMapping === "object"
      ? Object.entries(rawMapping as Record<string, string>).map(([key, value]) => ({
          key,
          value: value as "punched" | "writtenoff" | "cancelled",
        }))
      : [];
  return {
    priceType:
      typeof channel.settings["priceType"] === "string" ? channel.settings["priceType"] : "",
    splitWriteoffDocument: Boolean(channel.settings["splitWriteoffDocument"]),
    writeoffDocumentType:
      typeof channel.settings["writeoffDocumentType"] === "string"
        ? channel.settings["writeoffDocumentType"]
        : "",
    orderStatusField:
      typeof channel.settings["orderStatusField"] === "string"
        ? channel.settings["orderStatusField"]
        : "",
    statusMapping,
    silentAfterHours: channel.silentAfterHours,
  };
}

/**
 * CommerceML's own settings form -- `priceType` and `splitWriteoffDocument`,
 * mirroring `apps/api/src/modules/integrations/channel-registry.ts`'s
 * `commercemlSettings` schema, plus `silentAfterHours` (brief 08: the silence
 * threshold is a per-channel setting -- "у одного тенанта обмен раз в час, у
 * другого раз в сутки, и общая константа соврёт обоим"). `splitWriteoffDocument`
 * is saved here but only consumed by plan I-2 (per the task brief) -- this
 * task's job is just to persist it, not to act on it.
 *
 * `silentAfterHours` submits alongside the two settings fields but is its
 * own top-level column server-side (`silent_after_hours`, not a member of
 * the channel's JSONB `settings`) -- `integrations.service.ts`'s
 * `updateChannel` pulls it out of `patch` and validates/writes it
 * independently before either of these settings ever reach
 * `descriptor.settingsSchema`.
 *
 * `useForm`'s `defaultValues` are captured once at mount and never
 * resubscribe to `channel` on their own, but `channel` *does* change under
 * this form -- TanStack Query's default `refetchOnWindowFocus` means another
 * admin's edit can arrive at any time. The effect below re-syncs the form
 * whenever `channel` changes, but only while the operator hasn't started
 * editing (`!isDirty`), so an in-progress edit is never clobbered by
 * someone else's write; the same reasoning applies to the reset-after-save
 * inside `submit` below.
 */
function CommercemlSettingsForm({
  channel,
  onSave,
  saving,
}: {
  channel: ChannelDetailDto;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { isDirty, errors },
  } = useForm<CommercemlSettingsValues>({
    defaultValues: commercemlSettingsValuesOf(channel),
  });
  const { fields, append, remove } = useFieldArray({ control, name: "statusMapping" });

  useEffect(() => {
    if (!isDirty) {
      reset(commercemlSettingsValuesOf(channel));
    }
  }, [channel, isDirty, reset]);

  const submit = handleSubmit(async (values) => {
    const priceType = values.priceType.trim();
    const writeoffDocumentType = values.writeoffDocumentType.trim();
    const orderStatusField = values.orderStatusField.trim();
    const hadSavedStatusMapping = commercemlSettingsValuesOf(channel).statusMapping.length > 0;
    const statusMapping = Object.fromEntries(
      values.statusMapping
        .filter((row) => row.key.trim().length > 0)
        .map((row) => [row.key.trim(), row.value]),
    );
    try {
      await onSave({
        // Accepted limitation (final review, Fix 9): clearing this field and
        // saving does NOT reset a previously configured `priceType` back to
        // "decide by file" -- an empty value is omitted from the patch
        // entirely (the same convention `toCreateInput` in
        // `pages/catalog/ProductForm.tsx` uses for its own optional fields),
        // and `updateChannel` (integrations.service.ts) treats an omitted key
        // as "not touched", not "clear it". The server-side schema
        // (`commercemlSettings` in channel-registry.ts) only makes this
        // worse: `priceType` is `z.string().min(1).optional()`, so there is
        // no valid value that means "explicitly unset" even if this client
        // sent one. The operator sees their cleared field silently repopulate
        // with the old value the next time `channel` refetches and this form
        // resyncs (the effect above). Deliberately not fixed here -- it needs
        // a real "unset" representation server-side, not a client patch.
        ...(priceType ? { priceType } : {}),
        splitWriteoffDocument: values.splitWriteoffDocument,
        writeoffDocumentType: writeoffDocumentType || null,
        orderStatusField: orderStatusField || null,
        ...(Object.keys(statusMapping).length > 0 || hadSavedStatusMapping
          ? { statusMapping }
          : {}),
        silentAfterHours: values.silentAfterHours,
      });
      // Saved: this is the new clean baseline. Marking the form not-dirty
      // lets the effect above resync again on the next external change --
      // the query cache's own post-save data (set in `onSuccess`) settles
      // any small discrepancy between these locally-submitted values and
      // what the server actually persisted.
      reset(values);
    } catch {
      // `onSave` already reported the failure via toast (see
      // `handleSaveSettings`). Keep the operator's values and the dirty flag
      // so their edit isn't lost and the resync effect doesn't overwrite it
      // with now-stale server data.
    }
  });

  return (
    <form
      onSubmit={(event) => void submit(event)}
      // Fix (review, Task 13 follow-up): without `noValidate`, the browser's
      // own HTML5 constraint validation (triggered by `silentAfterHours`'s
      // native `min={1}` attribute below) intercepted the submit click and
      // silently refused to even dispatch the "submit" event -- react-hook-
      // form's own `handleSubmit`, and thus `formState.errors`, never ran at
      // all. Same convention as `pages/catalog/ProductForm.tsx`'s form.
      noValidate
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
      <Input
        label={t("pages.integrations.channel.settings.writeoffDocumentTypeLabel")}
        hint={t("pages.integrations.channel.settings.writeoffDocumentTypeHint")}
        {...register("writeoffDocumentType")}
      />
      <Input
        label={t("pages.integrations.channel.settings.orderStatusFieldLabel")}
        hint={t("pages.integrations.channel.settings.orderStatusFieldHint")}
        {...register("orderStatusField")}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ font: "600 13px/18px var(--font-ui)", color: "var(--fg-1)" }}>
          {t("pages.integrations.channel.settings.statusMappingLabel")}
        </span>
        <span style={{ font: "var(--text-caption)", color: "var(--fg-3)" }}>
          {t("pages.integrations.channel.settings.statusMappingHint")}
        </span>
        {fields.map((field, index) => (
          <div key={field.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Input
              aria-label={t("pages.integrations.channel.settings.statusMappingExternalLabel", {
                row: index + 1,
              })}
              placeholder={t(
                "pages.integrations.channel.settings.statusMappingExternalPlaceholder",
              )}
              {...register(`statusMapping.${index}.key` as const)}
            />
            <Controller
              control={control}
              name={`statusMapping.${index}.value` as const}
              render={({ field: controllerField }) => (
                <Select
                  aria-label={t("pages.integrations.channel.settings.statusMappingStatusLabel", {
                    row: index + 1,
                  })}
                  options={STATUS_MAPPING_OPTIONS.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey),
                  }))}
                  value={controllerField.value}
                  onChange={controllerField.onChange}
                />
              )}
            />
            <Button type="button" variant="secondary" onClick={() => remove(index)}>
              {t("pages.integrations.channel.settings.statusMappingRemoveAction")}
            </Button>
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => append({ key: "", value: "punched" })}
          >
            {t("pages.integrations.channel.settings.statusMappingAddAction")}
          </Button>
        </div>
      </div>
      <Input
        type="number"
        min={1}
        label={t("pages.integrations.channel.settings.silentAfterHoursLabel")}
        hint={t("pages.integrations.channel.settings.silentAfterHoursHint")}
        {...errorProp(
          errors.silentAfterHours?.message ? t(errors.silentAfterHours.message) : undefined,
        )}
        {...register("silentAfterHours", {
          valueAsNumber: true,
          min: {
            value: 1,
            // Fix (review, Task 13 follow-up): `min: 1` alone made an invalid
            // value (0, blank) fail react-hook-form's own validation --
            // `handleSubmit` then never called the submit handler at all, and
            // since `formState.errors` was never read anywhere, the operator
            // got no toast, no message, nothing. The i18n key here is
            // translated at render above, same convention `ProductForm.tsx`
            // uses for its zod issues.
            message: "pages.integrations.channel.settings.silentAfterHoursError",
          },
        })}
      />
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
 * never refetched -- see `useIssueCredentials` in `api.ts` for why it's a
 * plain async call rather than a `useMutation`, which is what makes "never
 * in the query cache" actually true instead of true-for-five-minutes. While
 * `issued` is set, the persisted-login line is hidden in favor of the
 * one-time reveal panel below -- showing both at once would render the
 * login text twice, which is redundant, not just noisy.
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
 * Admin channel page -- Plan I-1 Task 13 (+ Task 14's candidates queue).
 * One page per channel, regions per brief 08 ("Channel page"): header
 * (identity/state/last event), settings (the channel's own form plus its
 * exchange credentials), the candidates queue (only for channels that
 * actually import data -- see `CandidatesQueue` below), the public API keys
 * panel (only for `public_api` -- see `ApiKeysPanel` below), and journal
 * (`JournalList`). Kept as visually separate `Card`s rather than one merged
 * block deliberately -- each channel-specific area slots in as one more
 * region on this same page, and that only stays simple if these regions
 * never fuse into one.
 */
export function ChannelPage() {
  const { type: typeParam } = useParams<{ type: string }>();
  const type = typeParam ?? "";
  const { t, i18n } = useTranslation();

  const { data: channel, isPending, isError } = useChannelDetail(type);
  const updateSettings = useUpdateChannelSettings(type);
  const issueCredentials = useIssueCredentials(type);

  const [issued, setIssued] = useState<CredentialsIssuedDto | null>(null);
  const [issuing, setIssuing] = useState(false);

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
      // Re-thrown so `CommercemlSettingsForm`'s `submit` can tell a failed
      // save apart from a successful one -- it must keep the operator's
      // (unsaved) values and dirty flag on failure instead of resetting them.
      throw error;
    }
  };

  const handleIssueCredentials = async () => {
    setIssuing(true);
    try {
      const data = await issueCredentials.issue();
      setIssued(data);
      toast("ok", t("pages.integrations.channel.credentials.issueSuccess"));
    } catch (error) {
      toast(
        "error",
        error instanceof ApiRequestError
          ? error.message
          : t("pages.integrations.channel.credentials.issueError"),
      );
    } finally {
      setIssuing(false);
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

        {/*
         * Gated the same way `CommercemlSettingsForm` above is: `commerceml`
         * is the only channel that actually authenticates with this
         * login+secret pair on `POST /1c_exchange` (server's
         * `channel-registry.ts`'s `usesExchangeCredentials`, checked by
         * `IntegrationsService.issueCredentials`). Rendering this
         * unconditionally used to hand `public_api` a second, meaningless
         * "Выпустить"/one-time-secret widget next to `ApiKeysPanel`'s own --
         * a fully working button that minted a real login+secret nothing on
         * the server ever checks for that channel (its actual
         * authentication is the separate keys list below, not this).
         */}
        {channel.type === "commerceml" && (
          <CredentialsSection
            channel={channel}
            onIssue={() => void handleIssueCredentials()}
            issuing={issuing}
            issued={issued}
          />
        )}
      </Card>

      {/*
       * Only `commerceml` produces `integration_candidates` rows today
       * (see `integrations.service.ts`'s `unlinkProduct` doc comment) --
       * gated the same way `CommercemlSettingsForm` above is, so a channel
       * that imports nothing doesn't grow an always-empty queue card.
       */}
      {channel.type === "commerceml" && <CandidatesQueue type={type} />}

      {/*
       * `public_api` is a channel without a schedule (Task 15, task-15-brief.md):
       * its "settings" are the list of keys, not a form, so it gets its own
       * area instead of slotting into `CommercemlSettingsForm`'s branch above.
       */}
      {channel.type === "public_api" && <ApiKeysPanel />}

      <JournalList type={type} />
    </div>
  );
}
