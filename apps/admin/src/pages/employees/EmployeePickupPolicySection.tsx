import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Input, RadioGroup } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import {
  useUpdateEmployeePickupPolicy,
  type EmployeeDto,
  type EmployeePickupLimitMode,
} from "./api.js";

interface EmployeePickupPolicySectionProps {
  employee: EmployeeDto;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onErrorChange: (hasError: boolean) => void;
}

export function EmployeePickupPolicySection({
  employee,
  onDirtyChange,
  onBusyChange,
  onErrorChange,
}: EmployeePickupPolicySectionProps) {
  const { t } = useTranslation();
  const mutation = useUpdateEmployeePickupPolicy();
  const [limitMode, setLimitMode] = useState<EmployeePickupLimitMode>(
    employee.pickupPolicy.limitMode,
  );
  const [dayLimit, setDayLimit] = useState(String(employee.pickupPolicy.dayLimit));
  const [canWriteoff, setCanWriteoff] = useState(employee.pickupPolicy.canWriteoff);
  const [error, setError] = useState<string | null>(null);
  const validDayLimit = /^[1-9]\d*$/.test(dayLimit);
  const dirty =
    limitMode !== employee.pickupPolicy.limitMode ||
    dayLimit !== String(employee.pickupPolicy.dayLimit) ||
    canWriteoff !== employee.pickupPolicy.canWriteoff;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(mutation.isPending), [mutation.isPending, onBusyChange]);
  useEffect(
    () => onErrorChange(error !== null || !validDayLimit),
    [error, validDayLimit, onErrorChange],
  );

  const submit = async () => {
    if (!validDayLimit) return;
    try {
      setError(null);
      await mutation.mutateAsync({
        id: employee.id,
        input: { limitMode, dayLimit: Number(dayLimit), canWriteoff },
      });
      toast("ok", t("pages.employees.pickupPolicy.toasts.success"));
    } catch (cause) {
      setError(
        cause instanceof ApiRequestError
          ? cause.message
          : t("pages.employees.pickupPolicy.toasts.error"),
      );
    }
  };

  return (
    <section
      className="mk-employee-pickup-policy-section"
      role="region"
      aria-label={t("pages.employees.pickupPolicy.title")}
    >
      <h3 className="mk-employee-pickup-policy-section__title" tabIndex={-1}>
        {t("pages.employees.pickupPolicy.title")}
      </h3>
      <div className="mk-employee-pickup-policy-section__form">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <RadioGroup
          label={t("pages.employees.pickupPolicy.limitModeLabel")}
          options={[
            { value: "limited", label: t("pages.employees.pickupPolicy.limited") },
            { value: "unlimited", label: t("pages.employees.pickupPolicy.unlimited") },
          ]}
          value={limitMode}
          disabled={mutation.isPending}
          onValueChange={(value) => setLimitMode(value as EmployeePickupLimitMode)}
        />
        <Input
          label={t("pages.employees.pickupPolicy.dayLimitLabel")}
          {...(limitMode === "unlimited"
            ? { hint: t("pages.employees.pickupPolicy.retainedLimitHint") }
            : {})}
          {...(!validDayLimit ? { error: t("pages.employees.pickupPolicy.dayLimitError") } : {})}
          value={dayLimit}
          inputMode="numeric"
          mono
          disabled={mutation.isPending}
          onChange={(event) => setDayLimit(event.target.value)}
        />
        <Checkbox
          label={t("pages.employees.pickupPolicy.canWriteoffLabel")}
          hint={t("pages.employees.pickupPolicy.canWriteoffHint")}
          checked={canWriteoff}
          disabled={mutation.isPending}
          onCheckedChange={setCanWriteoff}
        />
        <div>
          <Button
            type="button"
            loading={mutation.isPending}
            disabled={!validDayLimit}
            onClick={() => void submit()}
          >
            {t("pages.employees.pickupPolicy.save")}
          </Button>
        </div>
      </div>
    </section>
  );
}
