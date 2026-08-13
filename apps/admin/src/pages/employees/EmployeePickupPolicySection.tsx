import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Checkbox, Input, RadioGroup } from "@markiro/ui";

import { ApiRequestError } from "../../api/client.js";
import { toast } from "../../lib/toast.js";
import {
  useUpdateEmployeePickupPolicy,
  type EmployeeDto,
  type EmployeePickupLimitMode,
  type EmployeePickupPolicyInput,
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
  const {
    limitMode: incomingLimitMode,
    dayLimit: incomingDayLimit,
    canWriteoff: incomingCanWriteoff,
  } = employee.pickupPolicy;
  const [limitMode, setLimitMode] = useState<EmployeePickupLimitMode>(incomingLimitMode);
  const [dayLimit, setDayLimit] = useState(String(incomingDayLimit));
  const [canWriteoff, setCanWriteoff] = useState(incomingCanWriteoff);
  const [baseline, setBaseline] = useState<EmployeePickupPolicyInput>(employee.pickupPolicy);
  const [error, setError] = useState<string | null>(null);
  const validDayLimit = /^[1-9]\d*$/.test(dayLimit);
  const dirty =
    limitMode !== baseline.limitMode ||
    dayLimit !== String(baseline.dayLimit) ||
    canWriteoff !== baseline.canWriteoff;
  const dirtyRef = useRef(false);
  const employeeIdRef = useRef(employee.id);

  useEffect(() => {
    dirtyRef.current = dirty;
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(mutation.isPending), [mutation.isPending, onBusyChange]);
  useEffect(
    () => onErrorChange(error !== null || !validDayLimit),
    [error, validDayLimit, onErrorChange],
  );
  useEffect(() => {
    const employeeChanged = employeeIdRef.current !== employee.id;
    if (!employeeChanged && dirtyRef.current) return;
    employeeIdRef.current = employee.id;
    setBaseline({
      limitMode: incomingLimitMode,
      dayLimit: incomingDayLimit,
      canWriteoff: incomingCanWriteoff,
    });
    setLimitMode(incomingLimitMode);
    setDayLimit(String(incomingDayLimit));
    setCanWriteoff(incomingCanWriteoff);
  }, [employee.id, incomingCanWriteoff, incomingDayLimit, incomingLimitMode]);

  const submit = async () => {
    if (!validDayLimit) return;
    try {
      setError(null);
      const savedEmployee = await mutation.mutateAsync({
        id: employee.id,
        input: { limitMode, dayLimit: Number(dayLimit), canWriteoff },
      });
      setBaseline(savedEmployee.pickupPolicy);
      setLimitMode(savedEmployee.pickupPolicy.limitMode);
      setDayLimit(String(savedEmployee.pickupPolicy.dayLimit));
      setCanWriteoff(savedEmployee.pickupPolicy.canWriteoff);
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
