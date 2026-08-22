import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  billingProfileInputSchema,
  operatorBillingProfileInputSchema,
  type BillingProfile,
  type BillingProfileInput,
  type DadataAddressSuggestion,
  type DadataOrganizationSuggestion,
  type OperatorBillingProfileInput,
} from "@markiro/platform-contracts";
import { Alert, Button, Checkbox, Input, Select } from "@markiro/ui";

import { AddressSuggestField } from "./AddressSuggestField.js";
import { OrganizationSuggestField } from "./OrganizationSuggestField.js";

type Profile = BillingProfile;
type ProfileInput = BillingProfileInput | OperatorBillingProfileInput;

interface Draft {
  kind: BillingProfileInput["kind"];
  fullName: string;
  displayName: string;
  inn: string;
  kpp: string;
  ogrn: string;
  ogrnip: string;
  legalAddressRaw: string;
  legalAddress: DadataAddressSuggestion | null;
  postalSameAsLegal: boolean;
  postalAddressRaw: string;
  postalAddress: DadataAddressSuggestion | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}

export function LegalProfileForm({
  scope,
  profile,
  canWrite,
  busy = false,
  onSave,
  onDirtyChange,
}: {
  scope: "operator" | "tenant";
  profile: Profile | null;
  canWrite: boolean;
  busy?: boolean;
  onSave: (input: ProfileInput) => Promise<unknown>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const baseline = useMemo(() => draftFromProfile(profile, scope), [profile, scope]);
  const [draft, setDraft] = useState<Draft>(baseline);
  const [organizationSearch, setOrganizationSearch] = useState(profile?.displayName ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  useEffect(() => {
    setDraft(baseline);
    setOrganizationSearch(profile?.displayName ?? "");
    setConfirmed(false);
    setSaved(false);
  }, [baseline, profile?.displayName]);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const patch = (next: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setSaved(false);
  };
  const selectOrganization = (suggestion: DadataOrganizationSuggestion) => {
    patch({
      kind: scope === "operator" ? "legal_entity" : suggestion.kind,
      fullName: suggestion.fullName,
      displayName: suggestion.displayName,
      inn: suggestion.inn,
      kpp: suggestion.kpp ?? "",
      ogrn: suggestion.ogrn ?? "",
      ogrnip: suggestion.ogrnip ?? "",
      ...(suggestion.legalAddress
        ? {
            legalAddressRaw: suggestion.legalAddress.value,
            legalAddress: suggestion.legalAddress,
          }
        : {}),
    });
    setOrganizationSearch(suggestion.value);
  };

  return (
    <form
      className="legal-profile-form"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        setSaved(false);
        if (!confirmed) {
          setError(t("legal.validation.confirm"));
          return;
        }
        const input = toInput(draft);
        const parsed =
          scope === "operator"
            ? operatorBillingProfileInputSchema.safeParse(input)
            : billingProfileInputSchema.safeParse(input);
        if (!parsed.success) {
          setError(t("legal.validation.invalid"));
          return;
        }
        void onSave(parsed.data).then(
          () => {
            setConfirmed(false);
            setSaved(true);
          },
          () => setError(t("legal.validation.saveFailed")),
        );
      }}
    >
      <fieldset disabled={!canWrite || busy}>
        <legend>{t("legal.sections.identity")}</legend>
        <div className="legal-form-grid legal-form-grid--two">
          {scope === "tenant" ? (
            <Select
              native
              label={t("legal.fields.kind")}
              value={draft.kind}
              onValueChange={(kind) => patch({ kind })}
              options={[
                { value: "legal_entity", label: t("legal.kinds.legal_entity") },
                { value: "sole_proprietor", label: t("legal.kinds.sole_proprietor") },
                { value: "self_employed", label: t("legal.kinds.self_employed") },
                { value: "individual", label: t("legal.kinds.individual") },
              ]}
            />
          ) : null}
          <OrganizationSuggestField
            value={organizationSearch}
            onValueChange={setOrganizationSearch}
            onSelect={selectOrganization}
            disabled={!canWrite || busy}
          />
          <Input
            label={t("legal.fields.fullName")}
            value={draft.fullName}
            onChange={(event) => patch({ fullName: event.target.value })}
            required
          />
          <Input
            label={t("legal.fields.displayName")}
            value={draft.displayName}
            onChange={(event) => patch({ displayName: event.target.value })}
            required
          />
          <Input
            label={t("legal.fields.inn")}
            value={draft.inn}
            onChange={(event) => patch({ inn: digits(event.target.value, 12) })}
            inputMode="numeric"
            mono
            required={draft.kind !== "individual"}
          />
          {draft.kind === "legal_entity" ? (
            <>
              <Input
                label={t("legal.fields.kpp")}
                value={draft.kpp}
                onChange={(event) => patch({ kpp: digits(event.target.value, 9) })}
                inputMode="numeric"
                mono
                required
              />
              <Input
                label={t("legal.fields.ogrn")}
                value={draft.ogrn}
                onChange={(event) => patch({ ogrn: digits(event.target.value, 13) })}
                inputMode="numeric"
                mono
                required
              />
            </>
          ) : null}
          {draft.kind === "sole_proprietor" ? (
            <Input
              label={t("legal.fields.ogrnip")}
              value={draft.ogrnip}
              onChange={(event) => patch({ ogrnip: digits(event.target.value, 15) })}
              inputMode="numeric"
              mono
              required
            />
          ) : null}
        </div>
      </fieldset>

      <fieldset disabled={!canWrite || busy}>
        <legend>{t("legal.sections.addresses")}</legend>
        <div className="legal-form-grid">
          <AddressSuggestField
            label={t("legal.fields.legalAddress")}
            value={draft.legalAddressRaw}
            onValueChange={(legalAddressRaw) => patch({ legalAddressRaw, legalAddress: null })}
            onSelect={(legalAddress) =>
              patch({ legalAddressRaw: legalAddress.value, legalAddress })
            }
            disabled={!canWrite || busy}
          />
          <Checkbox
            label={t("legal.fields.postalSame")}
            checked={draft.postalSameAsLegal}
            onCheckedChange={(postalSameAsLegal) => patch({ postalSameAsLegal })}
          />
          {!draft.postalSameAsLegal ? (
            <AddressSuggestField
              label={t("legal.fields.postalAddress")}
              value={draft.postalAddressRaw}
              onValueChange={(postalAddressRaw) => patch({ postalAddressRaw, postalAddress: null })}
              onSelect={(postalAddress) =>
                patch({ postalAddressRaw: postalAddress.value, postalAddress })
              }
              disabled={!canWrite || busy}
            />
          ) : null}
        </div>
      </fieldset>

      <fieldset disabled={!canWrite || busy}>
        <legend>{t("legal.sections.contacts")}</legend>
        <div className="legal-form-grid legal-form-grid--three">
          <Input
            label={t("legal.fields.contactName")}
            value={draft.contactName}
            onChange={(event) => patch({ contactName: event.target.value })}
          />
          <Input
            label={t("legal.fields.contactEmail")}
            value={draft.contactEmail}
            onChange={(event) => patch({ contactEmail: event.target.value })}
            type="email"
          />
          <Input
            label={t("legal.fields.contactPhone")}
            value={draft.contactPhone}
            onChange={(event) => patch({ contactPhone: event.target.value })}
            type="tel"
          />
        </div>
      </fieldset>

      <div className="legal-profile-confirmation">
        <Checkbox
          label={t("legal.confirmation")}
          checked={confirmed}
          onCheckedChange={setConfirmed}
          disabled={!canWrite || busy}
        />
        {profile ? (
          <span>
            {t("legal.revision", { revision: profile.revision })} ·{" "}
            {t("legal.confirmedAt", {
              date: new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
                new Date(profile.confirmedAt ?? profile.createdAt),
              ),
            })}
          </span>
        ) : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {saved ? <Alert tone="ok">{t("legal.saved")}</Alert> : null}
      <div className="legal-form-actions">
        <Button type="submit" loading={busy} disabled={!canWrite || !dirty}>
          {t("legal.save")}
        </Button>
        {!canWrite ? <span>{t("legal.readOnly")}</span> : null}
      </div>
    </form>
  );
}

function draftFromProfile(profile: Profile | null, scope: "operator" | "tenant"): Draft {
  return {
    kind: scope === "operator" ? "legal_entity" : (profile?.kind ?? "legal_entity"),
    fullName: profile?.fullName ?? "",
    displayName: profile?.displayName ?? "",
    inn: profile?.inn ?? "",
    kpp: profile?.kpp ?? "",
    ogrn: profile?.ogrn ?? "",
    ogrnip: profile?.ogrnip ?? "",
    legalAddressRaw: profile?.legalAddressRaw ?? "",
    legalAddress: profile?.legalAddress ?? null,
    postalSameAsLegal: profile?.postalSameAsLegal ?? true,
    postalAddressRaw: profile?.postalAddressRaw ?? "",
    postalAddress: profile?.postalAddress ?? null,
    contactName: profile?.contact?.name ?? "",
    contactEmail: profile?.contact?.email ?? "",
    contactPhone: profile?.contact?.phone ?? "",
  };
}

function toInput(draft: Draft): ProfileInput {
  const common = {
    fullName: draft.fullName.trim(),
    displayName: draft.displayName.trim(),
    legalAddressRaw: draft.legalAddressRaw.trim(),
    legalAddress: draft.legalAddress,
    postalAddress: draft.postalSameAsLegal
      ? ({ sameAsLegal: true } as const)
      : ({
          sameAsLegal: false as const,
          raw: draft.postalAddressRaw.trim(),
          normalized: draft.postalAddress,
        } as const),
    contact: {
      name: nullable(draft.contactName),
      email: nullable(draft.contactEmail),
      phone: nullable(draft.contactPhone),
    },
  };
  switch (draft.kind) {
    case "legal_entity":
      return {
        ...common,
        kind: "legal_entity",
        inn: draft.inn,
        kpp: draft.kpp,
        ogrn: draft.ogrn,
      };
    case "sole_proprietor":
      return { ...common, kind: "sole_proprietor", inn: draft.inn, ogrnip: draft.ogrnip };
    case "self_employed":
      return { ...common, kind: "self_employed", inn: draft.inn };
    case "individual":
      return { ...common, kind: "individual", inn: nullable(draft.inn) };
  }
}

function digits(value: string, max: number): string {
  return value.replace(/\D/g, "").slice(0, max);
}

function nullable(value: string): string | null {
  return value.trim() || null;
}
