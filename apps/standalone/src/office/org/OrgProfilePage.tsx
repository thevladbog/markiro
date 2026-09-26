import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Combobox, DefinitionGrid, Input, PageHeader } from "@markiro/ui";

import type { OrgProfile } from "../../host/protocol.js";
import { errorProp } from "../../lib/form-error.js";
import {
  issuerPrefix,
  ORG_HOST_FIELDS,
  orgFieldsSchema,
  THIRTEEN_DIGITS,
  toOrgInput,
  type OrgFields,
} from "../../lib/rules.js";
import { TIME_ZONE_OPTIONS } from "../../lib/time-zones.js";
import { writeFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError, PageLoading, StaleAlert } from "../page-state.js";

/** The organization profile (spec §5.5): administrators edit it, technologists read it. */
export function OrgProfilePage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("office.org.title")} />
      <OrgProfileContent />
    </>
  );
}

function OrgProfileContent() {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  const queryClient = useQueryClient();
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  // The revision the last save produced; its notice stays until the data changes.
  const [savedRev, setSavedRev] = useState<number | null>(null);

  if (org.isPending) return <PageLoading />;
  if (org.isError) return <LoadError error={org.error} onRetry={() => void org.refetch()} />;

  const saved = (profile: OrgProfile) => {
    queryClient.setQueryData(officeKeys.org, profile);
    setSavedRev(profile.rev);
  };

  return (
    <Card>
      {savedRev === org.data.rev && <Alert tone="ok">{t("office.common.saved")}</Alert>}
      {user.role === "admin" ? (
        // A new revision — after a save or a reload — starts the form afresh.
        <OrgProfileForm
          key={org.data.rev}
          profile={org.data}
          onSaved={saved}
          onReload={() => void org.refetch()}
        />
      ) : (
        <OrgProfileView profile={org.data} />
      )}
    </Card>
  );
}

interface OrgProfileFormProps {
  profile: OrgProfile;
  onSaved: (profile: OrgProfile) => void;
  onReload: () => void;
}

function OrgProfileForm({ profile, onSaved, onReload }: OrgProfileFormProps) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<
    { kind: "stale" } | { kind: "alert"; message: string } | null
  >(null);
  const update = useOfficeMutation((api, token, values: OrgFields) =>
    api.updateOrg(token, { ...toOrgInput(values), expectedRev: profile.rev }),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<OrgFields>({
    resolver: zodResolver(orgFieldsSchema),
    defaultValues: {
      orgName: profile.name,
      inn: profile.inn ?? "",
      gln: profile.gln,
      gs1Prefixes: profile.gs1Prefixes.join(", "),
      timeZone: profile.timeZone,
    },
  });
  const fieldError = (message: string | undefined) =>
    errorProp(message === undefined ? undefined : t(message));
  const gln = useWatch({ control, name: "gln" }).trim();
  const newPrefix =
    THIRTEEN_DIGITS.test(gln) && issuerPrefix(gln) !== issuerPrefix(profile.gln)
      ? issuerPrefix(gln)
      : null;

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      onSaved(await update.mutateAsync(values));
    } catch (error) {
      const outcome = writeFailure(error, ORG_HOST_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
    }
  });

  return (
    <form className="standalone-form" onSubmit={(event) => void submit(event)} noValidate>
      {failure?.kind === "stale" && <StaleAlert onReload={onReload} />}
      {failure?.kind === "alert" && <Alert tone="error">{t(failure.message)}</Alert>}
      <Input
        label={t("org.name")}
        {...fieldError(errors.orgName?.message)}
        {...register("orgName")}
      />
      <Input
        label={t("org.inn")}
        hint={t("org.innHint")}
        inputMode="numeric"
        mono
        {...fieldError(errors.inn?.message)}
        {...register("inn")}
      />
      <Input
        label={t("org.gln")}
        hint={t("org.glnHint")}
        inputMode="numeric"
        mono
        {...fieldError(errors.gln?.message)}
        {...register("gln")}
      />
      {newPrefix && (
        <Alert tone="warn">{t("office.org.prefixChange", { prefix: newPrefix })}</Alert>
      )}
      <Input
        label={t("org.gs1Prefixes")}
        hint={t("org.gs1PrefixesHint")}
        mono
        {...fieldError(errors.gs1Prefixes?.message)}
        {...register("gs1Prefixes")}
      />
      <Controller
        control={control}
        name="timeZone"
        render={({ field }) => (
          <Combobox
            label={t("org.timeZone")}
            options={TIME_ZONE_OPTIONS}
            value={field.value}
            onValueChange={field.onChange}
            placeholder={t("org.timeZonePlaceholder")}
            searchPlaceholder={t("org.timeZoneSearch")}
            emptyText={t("org.timeZoneEmpty")}
            loadingText={t("org.timeZoneLoading")}
            {...fieldError(errors.timeZone?.message)}
          />
        )}
      />
      <div className="standalone-form__actions">
        <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
          {t("office.common.save")}
        </Button>
      </div>
    </form>
  );
}

function OrgProfileView({ profile }: { profile: OrgProfile }) {
  const { t } = useTranslation();
  const none = t("office.common.none");
  return (
    <>
      <DefinitionGrid
        items={[
          { id: "name", term: t("org.name"), description: profile.name },
          { id: "inn", term: t("org.inn"), description: profile.inn ?? none, mono: true },
          { id: "gln", term: t("org.gln"), description: profile.gln, mono: true },
          {
            id: "gs1Prefixes",
            term: t("org.gs1Prefixes"),
            description: profile.gs1Prefixes.length > 0 ? profile.gs1Prefixes.join(", ") : none,
            mono: true,
          },
          {
            id: "timeZone",
            term: t("org.timeZone"),
            description: profile.timeZone.replaceAll("_", " "),
          },
        ]}
      />
      <p className="office-note">{t("office.common.readOnly")}</p>
    </>
  );
}
