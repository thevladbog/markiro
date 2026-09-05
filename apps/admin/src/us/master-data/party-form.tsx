import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button, Drawer, Input, Textarea } from "@markiro/ui";
import type { CreateUsParty, UsParty } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import type { MutationRelease } from "./workspace-shared.js";
import {
  emptyPartyForm,
  parsePartyForm,
  type FormErrorCode,
  type PartyFormValues,
} from "./forms.js";

export type PartySaveResult = "saved" | "conflict" | "forbidden" | "failed";

type PartyFormProps = {
  party?: UsParty;
  canWrite: boolean;
  onSave: (value: CreateUsParty) => Promise<PartySaveResult>;
  onClose: () => void;
  beginMutation: () => MutationRelease;
  onDirtyChange: (dirty: boolean) => void;
};

function initialValues(party?: UsParty): PartyFormValues {
  if (!party) return emptyPartyForm();
  return {
    name: party.name,
    legalName: party.legalName ?? "",
    contactName: party.contactName ?? "",
    contactPhone: party.contactPhone ?? "",
    contactEmail: party.contactEmail ?? "",
    notes: party.notes ?? "",
  };
}

export function PartyForm({
  party,
  canWrite,
  onSave,
  onClose,
  beginMutation,
  onDirtyChange,
}: PartyFormProps) {
  const { t } = useTranslation();
  const initial = useMemo(() => initialValues(party), [party]);
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, FormErrorCode | "conflict">>({});
  const [pending, setPending] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  function set<K extends keyof PartyFormValues>(field: K, value: PartyFormValues[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function requestClose() {
    if (pending) return;
    if (dirty && !window.confirm(t("md.discardConfirm"))) return;
    onClose();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !canWrite) return;
    const parsed = parsePartyForm(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    const releaseMutation = beginMutation();
    setPending(true);
    try {
      const result = await onSave(parsed.value);
      if (result === "conflict") setErrors((current) => ({ ...current, name: "conflict" }));
    } finally {
      setPending(false);
      releaseMutation();
    }
  }

  const error = (field: keyof PartyFormValues) => {
    const code = errors[field];
    if (field === "name" && code === "conflict") return t("md.nameConflict");
    if (code === "required") return t("md.requiredError");
    if (code === "format") return t("md.formatError");
    return undefined;
  };
  const errorProps = (field: keyof PartyFormValues) => {
    const value = error(field);
    return value ? { error: value } : {};
  };

  return (
    <Drawer
      open
      title={party ? t("md.editParty") : t("md.addParty")}
      closeLabel={t("md.close")}
      onClose={requestClose}
      className="us-md-drawer"
      footer={
        <>
          <Button variant="secondary" disabled={pending} onClick={requestClose}>
            {t("md.cancel")}
          </Button>
          {canWrite ? (
            <Button type="submit" form="us-party-form" loading={pending}>
              {t("md.saveParty")}
            </Button>
          ) : null}
        </>
      }
    >
      <form id="us-party-form" className="us-md-form" onSubmit={(event) => void submit(event)}>
        <Input
          label={t("md.name")}
          disabled={pending}
          value={form.name}
          onChange={(event) => set("name", event.target.value)}
          {...errorProps("name")}
          required
        />
        <Input
          label={t("md.legalName")}
          disabled={pending}
          value={form.legalName}
          onChange={(event) => set("legalName", event.target.value)}
          {...errorProps("legalName")}
        />
        <div className="us-md-form-grid">
          <Input
            label={t("md.contactName")}
            disabled={pending}
            value={form.contactName}
            onChange={(event) => set("contactName", event.target.value)}
            {...errorProps("contactName")}
          />
          <Input
            label={t("md.contactPhone")}
            disabled={pending}
            value={form.contactPhone}
            onChange={(event) => set("contactPhone", event.target.value)}
            {...errorProps("contactPhone")}
            inputMode="tel"
          />
        </div>
        <Input
          label={t("md.contactEmail")}
          disabled={pending}
          value={form.contactEmail}
          onChange={(event) => set("contactEmail", event.target.value)}
          {...errorProps("contactEmail")}
          type="email"
        />
        <Textarea
          label={t("md.notes")}
          disabled={pending}
          value={form.notes}
          onChange={(event) => set("notes", event.target.value)}
          rows={5}
          maxLength={2000}
          {...(errors.notes
            ? { "aria-invalid": true, "aria-describedby": "us-party-notes-error" }
            : {})}
        />
        {errors.notes ? (
          <p id="us-party-notes-error" className="us-md-field-error">
            {error("notes")}
          </p>
        ) : null}
      </form>
    </Drawer>
  );
}
