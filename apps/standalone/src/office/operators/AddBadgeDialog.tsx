import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm, type SubmitErrorHandler } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Alert, Input } from "@markiro/ui";

import { HostError } from "../../host/client.js";
import type { BadgeCreate, BadgeInfo, OfficeOperator } from "../../host/protocol.js";
import { badgeCreate } from "../../host/requests.js";
import { hashBadge } from "../../lib/credentials.js";
import { toOptionalText } from "../../lib/rules.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, WriteFailureAlert } from "../page-state.js";
import { badgeFormSchema, type BadgeFormValues } from "./badge-forms.js";
import { badgeHolder } from "./operator-records.js";

const BADGE_FIELDS = { badgePhc: "code", label: "label" } as const;
/** An active badge with this hash already exists, and the list does not know whose. */
const BADGE_CONFLICTS = {
  badge: { field: "code", message: "office.operators.badges.errors.taken" },
} as const;
const TAKEN_BY = "office.operators.badges.errors.takenBy";
/** The label holds the scanned code, which would leave in clear text (see `submit`). */
const LABEL_HAS_CODE = "office.operators.badges.errors.labelHasCode";

export interface AddBadgeDialogProps {
  operator: OfficeOperator;
  /** Every operator, to name the one who already holds a badge. */
  operators: readonly OfficeOperator[];
  onClose: () => void;
  onAdded: (badge: BadgeInfo) => void;
}

/**
 * A new badge for an operator. A keyboard-wedge scanner types the code and
 * Enter, which submits the form, so the code field takes the focus. The code
 * is hashed here and only the hash goes, under the site's salt: it is not read
 * again while it is cached (`staleTime: Infinity`), so a dialog opened again
 * soon reuses it, and it is read again once the cache has dropped it (about
 * five minutes without an add dialog), which is harmless, since it never
 * changes. A badge another operator holds is named under the code, and a label
 * that holds the code is refused: it would leave the webview in clear text.
 */
export function AddBadgeDialog({ operator, operators, onClose, onAdded }: AddBadgeDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  // The name `TAKEN_BY` interpolates: the operator the host named.
  const [holder, setHolder] = useState<string | null>(null);
  const salt = useOfficeQuery(officeKeys.badgeSalt, (api, token) => api.getBadgeSalt(token), {
    staleTime: Infinity,
  });
  const add = useOfficeMutation((api, token, body: BadgeCreate) =>
    api.createBadge(token, operator.id, body),
  );
  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<BadgeFormValues>({
    resolver: zodResolver(badgeFormSchema),
    defaultValues: { code: "", label: "" },
  });
  useEffect(() => {
    setFocus("code");
  }, [setFocus]);

  // The code field is masked, so nobody can see what it holds, and a scanner
  // types after it: a code that did not go through would be glued to the next
  // scan, which can pass every rule and be saved as a badge that no station's
  // scan will ever match. So after any failed attempt that involved the code
  // (the form refused it, the host refused it, or the request failed) the
  // field is emptied, without validating (a message stays until the next
  // input), and takes the focus back: a retry is a new scan.
  const scanAgain = () => {
    setValue("code", "");
    setFocus("code");
  };
  // A refusal of the code empties it; a refusal of the label alone (this one,
  // the host's, or a label that holds the code) keeps it, and the label is
  // corrected beside it.
  const refused: SubmitErrorHandler<BadgeFormValues> = (invalid) => {
    if (invalid.code !== undefined) scanAgain();
  };

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    // The submit button stays off until the salt is read.
    if (salt.data === undefined) return;
    // A scan lands in the label when the label was typed first and the focus
    // stayed there: the code is then appended to it, in clear text, and the
    // second scan into the code field would send it as the label. The host
    // keeps a label, writes it to the audit log, lists it and sends it to every
    // station, and revoking the badge takes none of that back. So it goes no
    // further: nothing is hashed or sent, and the code stays, since only the
    // label is wrong. Both values are the form's trimmed output.
    if (values.label.includes(values.code)) {
      setError("label", { type: "validate", message: LABEL_HAS_CODE }, { shouldFocus: true });
      return;
    }
    let added: BadgeInfo;
    try {
      const badgePhc = await hashBadge(values.code, salt.data.badgeSalt);
      added = await add.mutateAsync(badgeCreate({ badgePhc, label: toOptionalText(values.label) }));
    } catch (error) {
      const taken = badgeHolder(error, operators);
      if (taken !== null) {
        setHolder(taken.name);
        setError("code", { type: "server", message: TAKEN_BY });
        scanAgain();
        return;
      }
      const outcome = writeFailure(error, BADGE_FIELDS, BADGE_CONFLICTS);
      if (outcome.kind === "field") {
        // The focus goes to the field the host refused. It matters for the
        // label, which keeps the code beside it: the focus would stay in the
        // code field, and a reflex re-scan would be glued to the kept code.
        // A refused code is emptied and takes the focus back just below.
        setError(
          outcome.field,
          { type: "server", message: outcome.message },
          { shouldFocus: true },
        );
        if (outcome.field === "code") scanAgain();
      } else {
        setFailure(outcome);
        scanAgain();
      }
      return;
    }
    onAdded(added);
  }, refused);

  const saltFailure = () => {
    if (!salt.isError) return null;
    if (salt.error instanceof HostError && salt.error.code === "not_found") {
      return <Alert tone="error">{t("office.operators.badges.errors.noSalt")}</Alert>;
    }
    return <LoadError error={salt.error} onRetry={() => void salt.refetch()} />;
  };
  const codeMessage = errors.code?.message;
  // Until the salt is read nothing can be sent: the submit button is off, and
  // the code field takes no scan (it stays focusable), which would sit in it,
  // masked, in front of the next one. The same while a submit is in flight:
  // `isSubmitting` spans the validation, the hashing (about 100 ms of PBKDF2)
  // and the request, where `add.isPending` would start only with the request.
  // The field is editable again once the answer is in: a success closes the
  // dialog, and a failure empties the field for the next scan (`scanAgain`).
  const saltMissing = salt.data === undefined;

  return (
    <FormDialog
      title={t("office.operators.badges.addTitle", { name: operator.name })}
      submitLabel={t("office.operators.badges.addSubmit")}
      submitDisabled={saltMissing}
      onSubmit={submit}
      onClose={onClose}
      alert={
        <>
          {saltFailure()}
          <WriteFailureAlert failure={failure} />
        </>
      }
    >
      <Input
        type="password"
        label={t("office.operators.badges.fields.code")}
        hint={t("office.operators.badges.fields.codeHint")}
        mono
        readOnly={saltMissing || isSubmitting}
        {...fieldError(codeMessage, codeMessage === TAKEN_BY ? { name: holder } : undefined)}
        {...register("code")}
      />
      <Input
        label={t("office.operators.badges.fields.label")}
        hint={t("office.operators.badges.fields.labelHint")}
        {...fieldError(errors.label?.message)}
        {...register("label")}
      />
    </FormDialog>
  );
}
