import {
  platformServicePeriodContracts,
  type ServiceExcessApprovalPostInput,
} from "@markiro/platform-contracts";
import { Alert, Button, Input } from "@markiro/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { addServiceApproval } from "./api.js";
import { serviceAttemptNotice, type ServiceAttempt } from "./attempt-state.js";

export function ExternalApprovalForm({
  periodId,
  revision,
  onSuccess,
  onDirtyChange,
}: {
  periodId: string;
  revision: number;
  onSuccess: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const [minutes, setMinutes] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [attempt, setAttempt] = useState<ServiceAttempt<ServiceExcessApprovalPostInput> | null>(
    null,
  );
  const [validation, setValidation] = useState(false);
  const dirty = Boolean(minutes || reference || reason || attempt?.notice === "uncertain");
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const mutation = useMutation({
    mutationFn: async () => {
      if (attempt?.notice === "uncertain") return addServiceApproval(periodId, attempt.input);
      const parsed = platformServicePeriodContracts.addApproval.body.safeParse({
        requestId: crypto.randomUUID(),
        expectedRevision: revision,
        approvedMinutes: Number(minutes),
        externalReference: reference,
        externalUrl: null,
        approvedAt: new Date().toISOString(),
        reason,
      });
      if (!parsed.success) {
        setValidation(true);
        throw new Error("local_validation");
      }
      setValidation(false);
      setAttempt({ notice: "uncertain", requestId: parsed.data.requestId, input: parsed.data });
      return addServiceApproval(periodId, parsed.data);
    },
    onSuccess: () => {
      setAttempt(null);
      setMinutes("");
      setReference("");
      setReason("");
      onSuccess();
    },
    onError: (error) => {
      if (error instanceof Error && error.message === "local_validation") return;
      if (serviceAttemptNotice(error) !== "uncertain") setAttempt(null);
    },
  });
  const locked = attempt?.notice === "uncertain" || mutation.isPending;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <h3>{t("servicePeriods.approval.title")}</h3>
      <Input
        label={t("servicePeriods.approval.minutes")}
        value={minutes}
        disabled={locked}
        onChange={(event) => setMinutes(event.target.value)}
        inputMode="numeric"
      />
      <Input
        label={t("servicePeriods.approval.reference")}
        value={reference}
        disabled={locked}
        onChange={(event) => setReference(event.target.value)}
      />
      <Input
        label={t("servicePeriods.approval.reason")}
        value={reason}
        disabled={locked}
        onChange={(event) => setReason(event.target.value)}
      />
      {validation ? <Alert tone="error">{t("servicePeriods.validation")}</Alert> : null}
      {attempt?.notice === "uncertain" ? (
        <Alert tone="error">{t("servicePeriods.uncertain")}</Alert>
      ) : null}
      <Button type="submit" loading={mutation.isPending}>
        {attempt?.notice === "uncertain"
          ? t("servicePeriods.retry")
          : t("servicePeriods.approval.submit")}
      </Button>
    </form>
  );
}
