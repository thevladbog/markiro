import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { Button, Input } from "@markiro/ui";

import { BACKUP_DIR_PROBLEMS, type BackupState } from "../../host/backups.js";
import { HostError } from "../../host/client.js";
import { plainTextRule } from "../../lib/rules.js";
import { alertFailure, useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { useOfficeMutation } from "../office-query.js";
import { WriteFailureAlert } from "../page-state.js";
import { directoryProblem } from "./backup-dir.js";

/**
 * The host's rule (`routes/backups.rs`): 1-260 characters, no control
 * character, a full path with no `..` part and no device path. The office
 * checks it first so that each refusal says what to change.
 */
const secondDirSchema = z.object({
  secondDir: plainTextRule(260, "office.backups.secondDirRule")
    .refine((text) => directoryProblem(text) !== "device", "office.backups.dirRules.device")
    .refine((text) => directoryProblem(text) !== "parent", "office.backups.dirRules.parent")
    .refine(
      (text) => directoryProblem(text) !== "notAbsolute",
      "office.backups.dirRules.notAbsolute",
    ),
});
type SecondDirFields = z.infer<typeof secondDirSchema>;

/** A refusal the host words only as `validation_failed` on the field. */
const SECOND_DIR_FIELDS = {
  secondDir: { field: "secondDir", message: "office.backups.dirRules.hostRefused" },
} as const;

/** The text of a folder the host could not use (`details.reason` of a `backup_dir` conflict). */
function dirProblemKey(error: unknown): string | null {
  if (!(error instanceof HostError) || error.code !== "conflict") return null;
  if (error.details.constraint !== "backup_dir") return null;
  const reason = BACKUP_DIR_PROBLEMS.find((problem) => problem === error.details.reason);
  return `office.backups.dirProblems.${reason ?? "unknown"}`;
}

export interface SecondDirFormProps {
  state: BackupState;
  onSaved: (state: BackupState) => void;
  onSubmitStart: () => void;
  onReload: () => void;
}

/**
 * The second folder of copies; administrators only. The host tries the
 * folder before it saves it, so a share that is off or a drive that is
 * unplugged is refused here, under the field, in plain words.
 */
export function SecondDirForm({ state, onSaved, onSubmitStart, onReload }: SecondDirFormProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const update = useOfficeMutation((api, token, secondDir: string | null) =>
    api.updateBackupSettings(token, { secondDir, expectedRev: state.settingsRev }),
  );
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<SecondDirFields>({
    resolver: zodResolver(secondDirSchema),
    defaultValues: { secondDir: state.second?.dir ?? "" },
  });

  const save = async (secondDir: string | null) => {
    onSubmitStart();
    setFailure(null);
    let saved: BackupState;
    try {
      saved = await update.mutateAsync(secondDir);
    } catch (error) {
      const problem = dirProblemKey(error);
      if (problem !== null) {
        setError("secondDir", { type: "server", message: problem });
        return;
      }
      const outcome =
        secondDir === null ? alertFailure(error) : writeFailure(error, SECOND_DIR_FIELDS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onSaved(saved);
  };
  const submit = handleSubmit((fields) => save(fields.secondDir));

  return (
    <form className="standalone-form" onSubmit={(event) => void submit(event)} noValidate>
      <WriteFailureAlert failure={failure} onReload={onReload} />
      <Input
        label={t("office.backups.secondDir")}
        hint={t("office.backups.secondDirHint")}
        mono
        {...fieldError(errors.secondDir?.message)}
        {...register("secondDir")}
      />
      <div className="standalone-form__actions">
        <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
          {t("office.common.save")}
        </Button>
        {state.second !== null && (
          <Button
            variant="secondary"
            disabled={isSubmitting || update.isPending}
            onClick={() => void save(null)}
          >
            {t("office.backups.clearSecond")}
          </Button>
        )}
      </div>
    </form>
  );
}
