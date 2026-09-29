import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
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
 * is hashed here with the site's salt, read once per session, and only the
 * hash goes; a badge another operator holds is named under the code.
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
    formState: { errors },
  } = useForm<BadgeFormValues>({
    resolver: zodResolver(badgeFormSchema),
    defaultValues: { code: "", label: "" },
  });
  useEffect(() => {
    setFocus("code");
  }, [setFocus]);

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    // The submit button stays off until the salt is read.
    if (salt.data === undefined) return;
    let added: BadgeInfo;
    try {
      const badgePhc = await hashBadge(values.code, salt.data.badgeSalt);
      added = await add.mutateAsync(badgeCreate({ badgePhc, label: toOptionalText(values.label) }));
    } catch (error) {
      const taken = badgeHolder(error, operators);
      if (taken !== null) {
        setHolder(taken.name);
        setError("code", { type: "server", message: TAKEN_BY });
        return;
      }
      const outcome = writeFailure(error, BADGE_FIELDS, BADGE_CONFLICTS);
      if (outcome.kind === "field") {
        setError(outcome.field, { type: "server", message: outcome.message });
      } else {
        setFailure(outcome);
      }
      return;
    }
    onAdded(added);
  });

  const saltFailure = () => {
    if (!salt.isError) return null;
    if (salt.error instanceof HostError && salt.error.code === "not_found") {
      return <Alert tone="error">{t("office.operators.badges.errors.noSalt")}</Alert>;
    }
    return <LoadError error={salt.error} onRetry={() => void salt.refetch()} />;
  };
  const codeMessage = errors.code?.message;

  return (
    <FormDialog
      title={t("office.operators.badges.addTitle", { name: operator.name })}
      submitLabel={t("office.operators.badges.addSubmit")}
      submitDisabled={salt.data === undefined}
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
