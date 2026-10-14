import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useId, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { z } from "zod";

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  PageHeader,
  Table,
  type TableColumn,
} from "@markiro/ui";

import type { DisaggregationReason } from "../../host/disaggregation.js";
import { characters, isPlainText } from "../../lib/rules.js";
import { useCan } from "../access.js";
import { useFieldError, writeFailure, type AlertFailure } from "../form-errors.js";
import { FormDialog } from "../FormDialog.js";
import { officeKeys, useOfficeMutation, useOfficeQuery } from "../office-query.js";
import { LoadError, PageLoading, WriteFailureAlert } from "../page-state.js";
import { ArchiveStatus, useStoreRecord } from "../records.js";
import { byReasonOrder } from "./disaggregation-text.js";

/** The host's bounds of a reason's name and order (`disaggregation_reasons.rs`). */
const NAME_MAX = 120;
const ORDER_MAX = 1_000_000;

const KEYS = "office.disaggregation.reasons.errors";

const reasonFieldsSchema = z.object({
  name: z
    .string()
    .trim()
    .refine((text) => characters(text) >= 1, `${KEYS}.nameRequired`)
    .refine((text) => characters(text) <= NAME_MAX, `${KEYS}.nameTooLong`)
    .refine((text) => isPlainText(text, NAME_MAX), "rules.controlCharacter"),
  sortOrder: z
    .number({ error: `${KEYS}.sortOrderInvalid` })
    .int(`${KEYS}.sortOrderInvalid`)
    .min(-ORDER_MAX, `${KEYS}.sortOrderRange`)
    .max(ORDER_MAX, `${KEYS}.sortOrderRange`),
  archived: z.boolean(),
});
type ReasonFields = z.input<typeof reasonFieldsSchema>;

const REASON_FIELDS = { name: "name", sortOrder: "sortOrder" } as const;

interface ReasonDialogProps {
  /** `null` adds a reason; the next place after the last one is `nextOrder`. */
  reason: DisaggregationReason | null;
  nextOrder: number;
  onClose: () => void;
  onSaved: (reason: DisaggregationReason) => void;
  /** The reason changed on the host: close and load the reasons again. */
  onReload: () => void;
}

/**
 * Adds a reason, or changes one: the host takes the whole reason with the
 * loaded revision, and archiving is its `archived` flag (a reason is never
 * deleted).
 */
function ReasonDialog({ reason, nextOrder, onClose, onSaved, onReload }: ReasonDialogProps) {
  const { t } = useTranslation();
  const fieldError = useFieldError();
  const [failure, setFailure] = useState<AlertFailure | null>(null);
  const save = useOfficeMutation((api, token, values: z.output<typeof reasonFieldsSchema>) =>
    reason === null
      ? api.createDisaggregationReason(token, { name: values.name, sortOrder: values.sortOrder })
      : api.updateDisaggregationReason(token, reason.id, {
          name: values.name,
          sortOrder: values.sortOrder,
          archived: values.archived,
          expectedRev: reason.rev,
        }),
  );
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty },
  } = useForm<ReasonFields, unknown, z.output<typeof reasonFieldsSchema>>({
    resolver: zodResolver(reasonFieldsSchema),
    defaultValues:
      reason === null
        ? { name: "", sortOrder: nextOrder, archived: false }
        : { name: reason.name, sortOrder: reason.sortOrder, archived: reason.archived },
  });

  const submit = handleSubmit(async (values) => {
    setFailure(null);
    let saved: DisaggregationReason;
    try {
      saved = await save.mutateAsync(values);
    } catch (error) {
      const outcome = writeFailure(error, REASON_FIELDS);
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
    <FormDialog
      title={
        reason === null
          ? t("office.disaggregation.reasons.addTitle")
          : t("office.disaggregation.reasons.editTitle", { name: reason.name })
      }
      submitLabel={
        reason === null ? t("office.disaggregation.reasons.add") : t("office.common.save")
      }
      submitDisabled={reason !== null && !isDirty}
      onSubmit={submit}
      onClose={onClose}
      alert={<WriteFailureAlert failure={failure} onReload={onReload} />}
    >
      <Input
        label={t("office.disaggregation.reasons.name")}
        {...fieldError(errors.name?.message)}
        {...register("name")}
      />
      <Input
        type="number"
        step={1}
        mono
        label={t("office.disaggregation.reasons.sortOrder")}
        {...fieldError(errors.sortOrder?.message)}
        {...register("sortOrder", { valueAsNumber: true })}
      />
      {reason !== null && (
        <Controller
          control={control}
          name="archived"
          render={({ field }) => (
            <Checkbox
              label={t("office.disaggregation.reasons.archived")}
              hint={t("office.disaggregation.reasons.archivedHint")}
              checked={field.value}
              onCheckedChange={field.onChange}
            />
          )}
        />
      )}
    </FormDialog>
  );
}

type ReasonsDialog = { kind: "create" } | { kind: "edit"; reason: DisaggregationReason };

/**
 * The reasons of a disaggregation (plan ДЗГ-О), as the cloud's page of the
 * same name: a table, a dialog around one reason, and the archive instead of
 * a delete. The host gives both office roles the reasons, so `planShifts`
 * (the roles of the documents) decides who changes them.
 */
export function DisaggregationReasonsPage() {
  const { t } = useTranslation();
  const canWrite = useCan("planShifts");
  const reasons = useOfficeQuery(officeKeys.disaggregationReasons, (api, token) =>
    api.listDisaggregationReasons(token),
  );
  const store = useStoreRecord<DisaggregationReason>(officeKeys.disaggregationReasons);
  const [dialog, setDialog] = useState<ReasonsDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeId = useId();

  // After a write the dialog is gone: the notice takes the focus, so it is read and the keyboard
  // is not lost.
  useEffect(() => {
    if (notice !== null) document.getElementById(noticeId)?.focus();
  }, [notice, noticeId]);

  const open = (next: ReasonsDialog) => {
    setNotice(null);
    setDialog(next);
  };
  const saved = (reason: DisaggregationReason, message: string) => {
    store(reason);
    setDialog(null);
    setNotice(message);
  };
  const reload = () => {
    setDialog(null);
    void reasons.refetch();
  };

  const columns: TableColumn<DisaggregationReason>[] = [
    {
      key: "name",
      title: t("office.disaggregation.reasons.table.name"),
      wrap: true,
      minWidth: 220,
      render: (reason) => reason.name,
    },
    {
      key: "sortOrder",
      title: t("office.disaggregation.reasons.table.sortOrder"),
      mono: true,
      align: "right",
      render: (reason) => String(reason.sortOrder),
    },
    {
      key: "state",
      title: t("office.disaggregation.reasons.table.state"),
      render: (reason) => <ArchiveStatus archived={reason.archived} />,
    },
  ];
  if (canWrite) {
    columns.push({
      key: "actions",
      title: t("office.disaggregation.reasons.table.actions"),
      render: (reason) => (
        <Button
          variant="secondary"
          size="compact"
          aria-label={t("office.disaggregation.reasons.editNamed", { name: reason.name })}
          onClick={() => open({ kind: "edit", reason })}
        >
          {t("office.disaggregation.reasons.edit")}
        </Button>
      ),
    });
  }

  const content = () => {
    if (reasons.isPending) return <PageLoading />;
    if (reasons.isError) {
      return <LoadError error={reasons.error} onRetry={() => void reasons.refetch()} />;
    }
    return (
      <Card>
        <Table
          columns={columns}
          rows={[...reasons.data].sort(byReasonOrder)}
          getRowKey={(reason) => reason.id}
          empty={t("office.disaggregation.reasons.empty")}
          scrollLabel={t("office.disaggregation.reasons.title")}
        />
      </Card>
    );
  };

  // The next place after the last reason, archived ones included.
  const nextOrder = Math.min(
    ORDER_MAX,
    (reasons.data ?? []).reduce((last, reason) => Math.max(last, reason.sortOrder), -10) + 10,
  );

  return (
    <>
      {/* The class of the shift card's back link: a link on its own line, at the start. */}
      <Link className="shift-card__back" to="/disaggregation">
        {t("office.disaggregation.reasons.back")}
      </Link>
      <PageHeader
        title={t("office.disaggregation.reasons.title")}
        actions={
          canWrite ? (
            <Button onClick={() => open({ kind: "create" })}>
              {t("office.disaggregation.reasons.add")}
            </Button>
          ) : null
        }
      />
      {notice && (
        <Alert tone="ok" id={noticeId} tabIndex={-1}>
          {notice}
        </Alert>
      )}
      {content()}
      {canWrite && dialog !== null && (
        <ReasonDialog
          reason={dialog.kind === "edit" ? dialog.reason : null}
          nextOrder={nextOrder}
          onClose={() => setDialog(null)}
          onSaved={(reason) =>
            saved(
              reason,
              dialog.kind === "create"
                ? t("office.disaggregation.reasons.added", { name: reason.name })
                : t("office.common.saved"),
            )
          }
          onReload={reload}
        />
      )}
    </>
  );
}
