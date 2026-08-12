import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input, SidePanel } from "@markiro/ui";

import { errorProp } from "../../lib/form-error.js";
import type { CreateLineInput } from "../shifts/api.js";

const FORM_ID = "line-form";

export interface LineFormProps {
  mode: "create" | "edit";
  initialName?: string;
  submitting: boolean;
  submissionError: string | null;
  onSubmit: (input: CreateLineInput) => void | Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
}

export function LineForm({
  mode,
  initialName = "",
  submitting,
  submissionError,
  onSubmit,
  onDirtyChange,
  onClose,
}: LineFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [validationError, setValidationError] = useState<string | undefined>();
  const trimmedName = name.trim();

  useEffect(() => onDirtyChange(name !== initialName), [initialName, name, onDirtyChange]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || trimmedName.length === 0) return;
    if (trimmedName.length > 200) {
      setValidationError(t("pages.lines.form.errors.nameTooLong"));
      return;
    }
    setValidationError(undefined);
    await onSubmit({ name: trimmedName });
  };

  const title =
    mode === "create" ? t("pages.lines.form.createTitle") : t("pages.lines.form.editTitle");

  return (
    <SidePanel
      open
      size="standard"
      title={title}
      closeLabel={t("common.close")}
      busy={submitting}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>
            {t("pages.lines.cancel")}
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            loading={submitting}
            disabled={submitting || trimmedName.length === 0}
          >
            {mode === "create"
              ? t("pages.lines.form.submitCreate")
              : t("pages.lines.form.submitUpdate")}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="mk-line-form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        {submissionError ? <Alert tone="error">{submissionError}</Alert> : null}
        <Input
          label={t("pages.lines.form.nameLabel")}
          value={name}
          disabled={submitting}
          required
          maxLength={200}
          autoFocus
          {...errorProp(validationError)}
          {...(!validationError && trimmedName.length === 0
            ? { hint: t("pages.lines.form.errors.nameRequired") }
            : {})}
          onChange={(event) => {
            setName(event.currentTarget.value);
            if (validationError) setValidationError(undefined);
          }}
        />
      </form>
    </SidePanel>
  );
}
