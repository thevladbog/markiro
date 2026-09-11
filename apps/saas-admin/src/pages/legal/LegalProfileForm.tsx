import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  currentBillingProfileInputSchema,
  operatorBillingProfileInputV2Schema,
  type SellerTaxPolicy,
  type OperatorBillingProfileV2,
  type BillingProfile,
  type BillingProfileInput,
  type DadataAddressSuggestion,
  type DadataOrganizationSuggestion,
  type OperatorBillingProfileInputV2 as OperatorBillingProfileInput,
} from "@markiro/platform-contracts";
import { Alert, Button, Checkbox, Input, Select } from "@markiro/ui";

import { AddressSuggestField } from "./AddressSuggestField.js";
import { OrganizationSuggestField } from "./OrganizationSuggestField.js";

type Profile = BillingProfile | OperatorBillingProfileV2;
type ProfileInput = BillingProfileInput | OperatorBillingProfileInput;

interface Draft {
  kind: BillingProfileInput["kind"];
  taxMode: "unconfigured" | "npd" | "without_vat" | "vat";
  taxRates: string;
  taxDefault: string;
  taxIncluded: boolean;
  fullName: string;
  displayName: string;
  inn: string;
  kpp: string;
  ogrn: string;
  ogrnip: string;
  legalAddressRaw: string;
  legalAddress: DadataAddressSuggestion | null;
  actualSameAsLegal: boolean;
  actualAddressRaw: string;
  actualAddress: DadataAddressSuggestion | null;
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
  const personKind = draft.kind === "self_employed" || draft.kind === "individual";

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
      kind: suggestion.kind,
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
        if (busy) return;
        setError(null);
        setSaved(false);
        if (!confirmed) {
          setError(t("legal.validation.confirm"));
          return;
        }
        const input = toInput(draft);
        const parsed =
          scope === "operator"
            ? operatorBillingProfileInputV2Schema.safeParse({
                ...input,
                taxPolicy: taxPolicyFromDraft(draft),
              })
            : currentBillingProfileInputSchema.safeParse(input);
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
          <OrganizationSuggestField
            value={organizationSearch}
            onValueChange={setOrganizationSearch}
            onSelect={selectOrganization}
            disabled={!canWrite || busy}
          />
          <Input
            label={t(personKind ? "legal.fields.personName" : "legal.fields.fullName")}
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
            label={t(personKind ? "legal.fields.registrationAddress" : "legal.fields.legalAddress")}
            value={draft.legalAddressRaw}
            onValueChange={(legalAddressRaw) => patch({ legalAddressRaw, legalAddress: null })}
            onSelect={(legalAddress) =>
              patch({ legalAddressRaw: legalAddress.value, legalAddress })
            }
            disabled={!canWrite || busy}
          />
          <Checkbox
            label={t(
              personKind ? "legal.fields.actualSameRegistration" : "legal.fields.actualSameLegal",
            )}
            checked={draft.actualSameAsLegal}
            onCheckedChange={(actualSameAsLegal) => patch({ actualSameAsLegal })}
          />
          {!draft.actualSameAsLegal ? (
            <AddressSuggestField
              label={t("legal.fields.actualAddress")}
              value={draft.actualAddressRaw}
              onValueChange={(actualAddressRaw) => patch({ actualAddressRaw, actualAddress: null })}
              onSelect={(actualAddress) =>
                patch({ actualAddressRaw: actualAddress.value, actualAddress })
              }
              disabled={!canWrite || busy}
            />
          ) : null}
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

      {scope === "operator" ? (
        <fieldset disabled={!canWrite || busy}>
          <legend>{t("commercial.seller.title")}</legend>
          {draft.taxMode === "unconfigured" ? (
            <Alert tone="warn">{t("catalog.policyRequired")}</Alert>
          ) : null}
          <Select
            native
            label={t("commercial.seller.title")}
            value={draft.taxMode}
            onValueChange={(taxMode) => patch({ taxMode })}
            options={(["unconfigured", "npd", "without_vat", "vat"] as const).map((value) => ({
              value,
              label: t(`commercial.seller.${value}`),
            }))}
          />
          {draft.taxMode === "vat" ? (
            <div className="legal-form-grid legal-form-grid--two">
              <Input
                label={t("commercial.seller.rates")}
                value={draft.taxRates}
                onChange={(event) => patch({ taxRates: event.target.value })}
              />
              <Input
                label={t("commercial.seller.defaultRate")}
                inputMode="decimal"
                value={draft.taxDefault}
                onChange={(event) => patch({ taxDefault: event.target.value })}
              />
              <Checkbox
                label={t("catalog.vat.includedHint")}
                checked={draft.taxIncluded}
                onCheckedChange={(taxIncluded) => patch({ taxIncluded })}
              />
            </div>
          ) : null}
        </fieldset>
      ) : null}

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

function draftFromProfile(profile: Profile | null, _scope: "operator" | "tenant"): Draft {
  const policy = profile && "taxPolicy" in profile ? profile.taxPolicy : null;
  return {
    taxMode:
      policy?.kind === "vat"
        ? "vat"
        : policy?.kind === "without_vat"
          ? policy.regime === "npd"
            ? "npd"
            : "without_vat"
          : "unconfigured",
    taxRates:
      policy?.kind === "vat" ? policy.allowedRatesBps.map((rate) => rate / 100).join("; ") : "",
    taxDefault: policy?.kind === "vat" ? String(policy.defaultRateBps / 100) : "",
    taxIncluded: policy?.kind === "vat" ? policy.defaultIncluded : false,
    kind: profile?.kind ?? "legal_entity",
    fullName: profile?.fullName ?? "",
    displayName: profile?.displayName ?? "",
    inn: profile?.inn ?? "",
    kpp: profile?.kpp ?? "",
    ogrn: profile?.ogrn ?? "",
    ogrnip: profile?.ogrnip ?? "",
    legalAddressRaw: profile?.legalAddressRaw ?? "",
    legalAddress: profile?.legalAddress ?? null,
    actualSameAsLegal: profile?.actualSameAsLegal ?? true,
    actualAddressRaw: profile?.actualAddressRaw ?? "",
    actualAddress: profile?.actualAddress ?? null,
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
    actualAddress: draft.actualSameAsLegal
      ? ({ sameAsLegal: true } as const)
      : ({
          sameAsLegal: false as const,
          raw: draft.actualAddressRaw.trim(),
          normalized: draft.actualAddress,
        } as const),
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

function taxPolicyFromDraft(draft: Draft): SellerTaxPolicy | null {
  if (draft.taxMode === "unconfigured") return null;
  if (draft.taxMode !== "vat")
    return { kind: "without_vat", regime: draft.taxMode === "npd" ? "npd" : "other" };
  const rate = (text: string) =>
    /^(?:100(?:[.,]0{1,2})?|\d{1,2}(?:[.,]\d{1,2})?)$/.test(text.trim())
      ? Math.round(Number(text.trim().replace(",", ".")) * 100)
      : NaN;
  return {
    kind: "vat",
    regime: "other",
    allowedRatesBps: draft.taxRates.split(";").map(rate),
    defaultRateBps: rate(draft.taxDefault),
    defaultIncluded: draft.taxIncluded,
  };
}
