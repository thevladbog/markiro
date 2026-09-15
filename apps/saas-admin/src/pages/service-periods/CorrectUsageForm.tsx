import type { ServicePeriodDetail } from "./api.js";
import {
  platformServicePeriodContracts,
  type ServiceUsageCorrectionInput,
} from "@markiro/platform-contracts";
import { Alert, Button, Input, Select } from "@markiro/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { correctServiceUsage } from "./api.js";
import { serviceAttemptNotice, type ServiceAttempt } from "./attempt-state.js";

type Entry = ServicePeriodDetail["entries"][number];
export function CorrectUsageForm({
  periodId,
  revision,
  entry,
  onSuccess,
  onDirtyChange,
}: {
  periodId: string;
  revision: number;
  entry: Entry;
  onSuccess: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const [classification, setClassification] = useState(entry.classification);
  const [actual, setActual] = useState("");
  const [allowance, setAllowance] = useState("");
  const [description, setDescription] = useState("");
  const [attempt, setAttempt] = useState<ServiceAttempt<ServiceUsageCorrectionInput> | null>(null);
  const dirty = Boolean(
    actual ||
    allowance ||
    description ||
    classification !== entry.classification ||
    attempt?.notice === "uncertain",
  );
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const mutation = useMutation({
    mutationFn: async () => {
      if (attempt?.notice === "uncertain")
        return correctServiceUsage(periodId, entry.id, attempt.input);
      const parsed = platformServicePeriodContracts.correctUsage.body.safeParse({
        requestId: crypto.randomUUID(),
        expectedRevision: revision,
        classification,
        actualMinutesDelta: Number(actual),
        allowanceMinutesDelta: Number(allowance),
        description,
        internalNote: null,
      });
      if (!parsed.success) throw new Error("local_validation");
      setAttempt({ notice: "uncertain", requestId: parsed.data.requestId, input: parsed.data });
      return correctServiceUsage(periodId, entry.id, parsed.data);
    },
    onSuccess: () => {
      setAttempt(null);
      onSuccess();
    },
    onError: (error) => {
      if (
        !(error instanceof Error && error.message === "local_validation") &&
        serviceAttemptNotice(error) !== "uncertain"
      )
        setAttempt(null);
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
      <h3>{t("servicePeriods.correction.title")}</h3>
      <Select
        label={t("servicePeriods.usage.classification")}
        value={classification}
        disabled={locked}
        onValueChange={setClassification}
        options={[
          { value: "customer_service", label: t("servicePeriods.classification.customer_service") },
          { value: "product_defect", label: t("servicePeriods.classification.product_defect") },
        ]}
      />
      <Input
        label={t("servicePeriods.correction.actual")}
        value={actual}
        disabled={locked}
        onChange={(event) => setActual(event.target.value)}
      />
      <Input
        label={t("servicePeriods.correction.allowance")}
        value={allowance}
        disabled={locked}
        onChange={(event) => setAllowance(event.target.value)}
      />
      <Input
        label={t("servicePeriods.usage.description")}
        value={description}
        disabled={locked}
        onChange={(event) => setDescription(event.target.value)}
      />
      {mutation.error ? (
        <Alert tone="error">
          {attempt?.notice === "uncertain"
            ? t("servicePeriods.uncertain")
            : t("servicePeriods.validation")}
        </Alert>
      ) : null}
      <Button type="submit" loading={mutation.isPending}>
        {attempt?.notice === "uncertain"
          ? t("servicePeriods.retry")
          : t("servicePeriods.correction.submit")}
      </Button>
    </form>
  );
}
