import type { AgreementRequisitesInput } from "@markiro/platform-contracts";
import { Field, Input, Select } from "@markiro/ui";
import { useTranslation } from "react-i18next";

import { AddressSuggestField } from "../legal/AddressSuggestField.js";
import { BankSuggestField } from "../legal/BankSuggestField.js";
import { OrganizationSuggestField } from "../legal/OrganizationSuggestField.js";

export type RequisitesDraft = {
  kind: AgreementRequisitesInput["kind"];
  name: string;
  inn: string;
  kpp: string;
  ogrn: string;
  ogrnip: string;
  address: string;
  email: string;
  phone: string;
  bankName: string;
  bic: string;
  settlementAccount: string;
  correspondentAccount: string;
};

export const EMPTY_REQUISITES: RequisitesDraft = {
  kind: "legal_entity",
  name: "",
  inn: "",
  kpp: "",
  ogrn: "",
  ogrnip: "",
  address: "",
  email: "",
  phone: "",
  bankName: "",
  bic: "",
  settlementAccount: "",
  correspondentAccount: "",
};

const KINDS = [
  "legal_entity",
  "sole_proprietor",
  "self_employed",
  "individual",
] as const satisfies readonly AgreementRequisitesInput["kind"][];

const nullable = (value: string): string | null => (value.trim() === "" ? null : value.trim());

/** Throws nothing: the contract schema is the validator, this only shapes. */
export function toRequisitesInput(draft: RequisitesDraft): unknown {
  const base = {
    name: draft.name.trim(),
    address: nullable(draft.address),
    email: nullable(draft.email),
    phone: nullable(draft.phone),
    bankName: nullable(draft.bankName),
    bic: nullable(draft.bic),
    settlementAccount: nullable(draft.settlementAccount),
    correspondentAccount: nullable(draft.correspondentAccount),
  };
  if (draft.kind === "legal_entity") {
    return { ...base, kind: draft.kind, inn: draft.inn, kpp: draft.kpp, ogrn: draft.ogrn };
  }
  if (draft.kind === "sole_proprietor") {
    return { ...base, kind: draft.kind, inn: draft.inn, ogrnip: draft.ogrnip };
  }
  if (draft.kind === "self_employed") {
    return { ...base, kind: draft.kind, inn: draft.inn };
  }
  return { ...base, kind: draft.kind, inn: nullable(draft.inn) };
}

export function fromRequisites(value: AgreementRequisitesInput): RequisitesDraft {
  return {
    ...EMPTY_REQUISITES,
    kind: value.kind,
    name: value.name,
    inn: value.inn ?? "",
    kpp: "kpp" in value ? value.kpp : "",
    ogrn: "ogrn" in value ? value.ogrn : "",
    ogrnip: "ogrnip" in value ? value.ogrnip : "",
    address: value.address ?? "",
    email: value.email ?? "",
    phone: value.phone ?? "",
    bankName: value.bankName ?? "",
    bic: value.bic ?? "",
    settlementAccount: value.settlementAccount ?? "",
    correspondentAccount: value.correspondentAccount ?? "",
  };
}

export function AgreementRequisitesForm({
  value,
  onChange,
  disabled = false,
}: {
  value: RequisitesDraft;
  onChange: (next: RequisitesDraft) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const set = <K extends keyof RequisitesDraft>(key: K, next: RequisitesDraft[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <div className="agreement-requisites">
      <Select
        id="agreement-kind"
        label={t("agreements.fields.kind")}
        value={value.kind}
        disabled={disabled}
        options={KINDS.map((kind) => ({ value: kind, label: t(`agreements.kinds.${kind}`) }))}
        onValueChange={(next) => set("kind", next)}
      />

      {!disabled && (
        <OrganizationSuggestField
          value={value.inn}
          onValueChange={(next) => set("inn", next)}
          onSelect={(suggestion) =>
            onChange({
              ...value,
              // A suggestion fills; every field below stays editable, so a
              // later manual correction simply wins.
              kind: suggestion.kind,
              name: suggestion.displayName,
              inn: suggestion.inn,
              kpp: suggestion.kpp ?? "",
              ogrn: suggestion.ogrn ?? "",
              ogrnip: suggestion.ogrnip ?? "",
              address: suggestion.legalAddress?.value ?? value.address,
            })
          }
        />
      )}

      <Field label={t("agreements.fields.name")} htmlFor="agreement-name">
        <Input
          id="agreement-name"
          value={value.name}
          disabled={disabled}
          onChange={(event) => set("name", event.target.value)}
        />
      </Field>

      <Field label={t("agreements.fields.inn")} htmlFor="agreement-inn">
        <Input
          id="agreement-inn"
          value={value.inn}
          inputMode="numeric"
          disabled={disabled}
          onChange={(event) => set("inn", event.target.value)}
        />
      </Field>

      {value.kind === "legal_entity" && (
        <>
          <Field label={t("agreements.fields.kpp")} htmlFor="agreement-kpp">
            <Input
              id="agreement-kpp"
              value={value.kpp}
              inputMode="numeric"
              disabled={disabled}
              onChange={(event) => set("kpp", event.target.value)}
            />
          </Field>
          <Field label={t("agreements.fields.ogrn")} htmlFor="agreement-ogrn">
            <Input
              id="agreement-ogrn"
              value={value.ogrn}
              inputMode="numeric"
              disabled={disabled}
              onChange={(event) => set("ogrn", event.target.value)}
            />
          </Field>
        </>
      )}

      {value.kind === "sole_proprietor" && (
        <Field label={t("agreements.fields.ogrnip")} htmlFor="agreement-ogrnip">
          <Input
            id="agreement-ogrnip"
            value={value.ogrnip}
            inputMode="numeric"
            disabled={disabled}
            onChange={(event) => set("ogrnip", event.target.value)}
          />
        </Field>
      )}

      {disabled ? (
        <Field label={t("agreements.fields.address")} htmlFor="agreement-address">
          <Input id="agreement-address" value={value.address} disabled />
        </Field>
      ) : (
        <AddressSuggestField
          label={t("agreements.fields.address")}
          value={value.address}
          onValueChange={(next) => set("address", next)}
          onSelect={(suggestion) => set("address", suggestion.value)}
        />
      )}

      <Field label={t("agreements.fields.email")} htmlFor="agreement-email">
        <Input
          id="agreement-email"
          type="email"
          value={value.email}
          disabled={disabled}
          onChange={(event) => set("email", event.target.value)}
        />
      </Field>

      <Field label={t("agreements.fields.phone")} htmlFor="agreement-phone">
        <Input
          id="agreement-phone"
          value={value.phone}
          disabled={disabled}
          onChange={(event) => set("phone", event.target.value)}
        />
      </Field>

      {!disabled && (
        <BankSuggestField
          value={value.bic}
          onValueChange={(next) => set("bic", next)}
          onSelect={(suggestion) =>
            onChange({
              ...value,
              bic: suggestion.bic,
              bankName: suggestion.bankName,
              correspondentAccount: suggestion.correspondentAccount ?? value.correspondentAccount,
            })
          }
        />
      )}

      <Field label={t("agreements.fields.bankName")} htmlFor="agreement-bank">
        <Input
          id="agreement-bank"
          value={value.bankName}
          disabled={disabled}
          onChange={(event) => set("bankName", event.target.value)}
        />
      </Field>

      <Field label={t("agreements.fields.bic")} htmlFor="agreement-bic">
        <Input
          id="agreement-bic"
          value={value.bic}
          inputMode="numeric"
          disabled={disabled}
          onChange={(event) => set("bic", event.target.value)}
        />
      </Field>

      <Field label={t("agreements.fields.settlementAccount")} htmlFor="agreement-rs">
        <Input
          id="agreement-rs"
          value={value.settlementAccount}
          inputMode="numeric"
          disabled={disabled}
          onChange={(event) => set("settlementAccount", event.target.value)}
        />
      </Field>

      <Field label={t("agreements.fields.correspondentAccount")} htmlFor="agreement-ks">
        <Input
          id="agreement-ks"
          value={value.correspondentAccount}
          inputMode="numeric"
          disabled={disabled}
          onChange={(event) => set("correspondentAccount", event.target.value)}
        />
      </Field>
    </div>
  );
}
