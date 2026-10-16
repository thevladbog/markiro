import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, Combobox, DefinitionGrid, Input, PageHeader } from "@markiro/ui";

import type { OrgProfile } from "../../host/protocol.js";
import {
  issuerPrefix,
  ORG_HOST_FIELDS,
  orgFieldsSchema,
  THIRTEEN_DIGITS,
  toOrgInput,
  type OrgFields,
} from "../../lib/rules.js";
import { TIME_ZONE_OPTIONS } from "../../lib/time-zones.js";
import { useCan } from "../access.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading, WriteFailureAlert } from "../page-state.js";
import { OrgLogoCard } from "./OrgLogoCard.js";

/** The organization profile (spec §5.5): administrators edit it, technologists read it. */
export function OrgProfilePage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t("office.org.title")} description={t("office.org.subtitle")} />
      <div className="office-split">
        <OrgProfileContent />
        <OrgLogoCard />
      </div>
    </>
  );
}

function OrgProfileContent() {
  const { t } = useTranslation();
  const canEdit = useCan("editReference");
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
    <Card title={t("office.org.card")} titleAs="h2" className="org-card">
      {savedRev === org.data.rev && <Alert tone="ok">{t("office.common.saved")}</Alert>}
      {canEdit ? (
        // A new revision — after a save or a reload — starts the form afresh.
        <OrgProfileForm
          key={org.data.rev}
          profile={org.data}
          onSaved={saved}
          onSubmitStart={() => setSavedRev(null)}
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
  onSubmitStart: () => void;
  onReload: () => void;
}

function OrgProfileForm({ profile, onSaved, onSubmitStart, onReload }: OrgProfileFormProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
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
  const gln = useWatch({ control, name: "gln" }).trim();
  const newPrefix =
    THIRTEEN_DIGITS.test(gln) && issuerPrefix(gln) !== issuerPrefix(profile.gln)
      ? issuerPrefix(gln)
      : null;

  const submit = handleSubmit(async (values) => {
    onSubmitStart();
    setFailure(null);
    let saved: OrgProfile;
    try {
      saved = await update.mutateAsync(values);
    } catch (error) {
      const outcome = writeFailure(error, ORG_HOST_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  });

  return (
    <form className="standalone-form" onSubmit={(event) => void submit(event)} noValidate>
      <WriteFailureAlert failure={failure} onReload={onReload} />
      <Input
        label={t("org.name")}
        {...fieldError(errors.orgName?.message)}
        {...register("orgName")}
      />
      <div className="office-form-row">
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
      </div>
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
