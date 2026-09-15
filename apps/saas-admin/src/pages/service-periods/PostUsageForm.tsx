import {
  platformServicePeriodContracts,
  type ServiceUsagePostInput,
} from "@markiro/platform-contracts";
import { Alert, Button, Input, Select, Textarea } from "@markiro/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { postServiceUsage } from "./api.js";
import { serviceAttemptNotice, type ServiceAttempt } from "./attempt-state.js";

export function PostUsageForm({
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
  const [classification, setClassification] = useState<"customer_service" | "product_defect">(
    "customer_service",
  );
  const [minutes, setMinutes] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [attempt, setAttempt] = useState<ServiceAttempt<ServiceUsagePostInput> | null>(null);
  const [validation, setValidation] = useState(false);
  const dirty = Boolean(minutes || reference || description || attempt?.notice === "uncertain");
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (attempt?.notice === "uncertain") return postServiceUsage(periodId, attempt.input);
      const parsed = platformServicePeriodContracts.postUsage.body.safeParse({
        requestId: crypto.randomUUID(),
        expectedRevision: revision,
        classification,
        performedAt: new Date().toISOString(),
        actualMinutes: Number(minutes),
        allowanceMinutes: classification === "product_defect" ? 0 : Number(minutes),
        workReference: reference,
        description,
        internalNote: null,
      });
      if (!parsed.success) {
        setValidation(true);
        throw new Error("local_validation");
      }
      setValidation(false);
      setAttempt({ notice: "uncertain", requestId: parsed.data.requestId, input: parsed.data });
      return postServiceUsage(periodId, parsed.data);
    },
    onSuccess: () => {
      setAttempt(null);
      setMinutes("");
      setReference("");
      setDescription("");
      onSuccess();
    },
    onError: (error) => {
      if (error instanceof Error && error.message === "local_validation") return;
      const notice = serviceAttemptNotice(error);
      if (notice !== "uncertain") setAttempt(null);
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
      <h3>{t("servicePeriods.usage.title")}</h3>
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
        label={t("servicePeriods.usage.minutes")}
        value={minutes}
        disabled={locked}
        onChange={(event) => setMinutes(event.target.value)}
        inputMode="numeric"
      />
      <Input
        label={t("servicePeriods.usage.reference")}
        value={reference}
        disabled={locked}
        onChange={(event) => setReference(event.target.value)}
      />
      <Textarea
        label={t("servicePeriods.usage.description")}
        value={description}
        disabled={locked}
        onChange={(event) => setDescription(event.target.value)}
      />
      {validation ? <Alert tone="error">{t("servicePeriods.validation")}</Alert> : null}
      {attempt?.notice === "uncertain" ? (
        <Alert tone="error">{t("servicePeriods.uncertain")}</Alert>
      ) : null}
      <Button type="submit" loading={mutation.isPending}>
        {attempt?.notice === "uncertain"
          ? t("servicePeriods.retry")
          : t("servicePeriods.usage.submit")}
      </Button>
    </form>
  );
}
