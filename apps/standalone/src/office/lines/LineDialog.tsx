import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Input } from "@markiro/ui";

import type { OfficeLine } from "../../host/protocol.js";
import { lineCreate, lineUpdate } from "../../host/requests.js";
import { lineNameRule } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";

const lineFieldsSchema = z.object({ name: lineNameRule });
type LineFields = z.input<typeof lineFieldsSchema>;

const LINE_FIELDS = { name: "name" } as const;
/** An active line already has the name, compared without case (`lines_active_name_key`). */
const LINE_CONFLICTS = {
  line_name: { field: "name", message: "office.lines.errors.nameTaken" },
} as const;

/** What the dialog does: add a line, rename an active one, or bring one back from the archive. */
export type LineDialogMode =
  { kind: "create" } | { kind: "rename"; line: OfficeLine } | { kind: "restore"; line: OfficeLine };

export interface LineDialogProps {
  mode: LineDialogMode;
  onClose: () => void;
  onSaved: (line: OfficeLine) => void;
  /** The line changed on the host: close and load the lines again. */
  onReload: () => void;
}

/**
 * A line's name. A name an active line already has (without case) comes back
 * as `conflict` on `line_name` on every path here — adding, renaming and
 * bringing a line back — and goes under the name, so bringing a line back can
 * give it a new name in the same dialog.
 */
export function LineDialog({ mode, onClose, onSaved, onReload }: LineDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const save = useOfficeMutation((api, token, name: string) => {
    switch (mode.kind) {
      case "create":
        return api.createLine(token, lineCreate(name));
      case "rename":
        return api.updateLine(
          token,
          mode.line.id,
          lineUpdate(mode.line, { name, archived: mode.line.archived }),
        );
      case "restore":
        return api.updateLine(
          token,
          mode.line.id,
          lineUpdate(mode.line, { name, archived: false }),
        );
    }
  });
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<LineFields>({
    resolver: zodResolver(lineFieldsSchema),
    defaultValues: { name: mode.kind === "create" ? "" : mode.line.name },
  });

  const submit = handleSubmit(async ({ name }) => {
    setFailure(null);
    let saved: OfficeLine;
    try {
      saved = await save.mutateAsync(name);
    } catch (error) {
      const outcome = writeFailure(error, LINE_FIELDS, LINE_CONFLICTS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  });

  const title =
    mode.kind === "create"
      ? t("office.lines.createTitle")
      : mode.kind === "rename"
        ? t("office.lines.renameTitle", { name: mode.line.name })
        : t("office.lines.restoreTitle", { name: mode.line.name });
  const submitLabel =
    mode.kind === "create"
      ? t("office.lines.create")
      : mode.kind === "rename"
        ? t("office.common.save")
        : t("office.lines.restoreSubmit");

  return (
    <FormDialog
      title={title}
      submitLabel={submitLabel}
      submitDisabled={mode.kind === "rename" && !isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      {mode.kind === "restore" && <p>{t("office.lines.restoreIntro")}</p>}
      <Input
        label={t("office.lines.fields.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
    </FormDialog>
  );
}
