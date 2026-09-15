import { useTranslation } from "react-i18next";

import { Alert, Input, Select, Textarea } from "@markiro/ui";

export type MonthlyServiceTermsDraft = {
  includedMinutes: string;
  scopeRu: string;
  scopeEn: string;
  operatingHoursRu: string;
  operatingHoursEn: string;
  schedulingTermsRu: string;
  schedulingTermsEn: string;
};

export const EMPTY_MONTHLY_SERVICE_TERMS: MonthlyServiceTermsDraft = {
  includedMinutes: "",
  scopeRu: "",
  scopeEn: "",
  operatingHoursRu: "",
  operatingHoursEn: "",
  schedulingTermsRu: "",
  schedulingTermsEn: "",
};

export function MonthlyServiceTermsFields({
  billingMode,
  onBillingModeChange,
  value,
  onChange,
  disabled = false,
  errors = {},
}: {
  billingMode: "one_time" | "recurring";
  onBillingModeChange: (mode: "one_time" | "recurring") => void;
  value: MonthlyServiceTermsDraft;
  onChange: (value: MonthlyServiceTermsDraft) => void;
  disabled?: boolean;
  errors?: Partial<Record<keyof MonthlyServiceTermsDraft, string>>;
}) {
  const { t } = useTranslation();
  const change = (key: keyof MonthlyServiceTermsDraft, next: string) =>
    onChange({ ...value, [key]: next });

  return (
    <fieldset disabled={disabled}>
      <legend>{t("catalog.monthlyService.title")}</legend>
      <div className="form-grid form-grid--two">
        <Select
          label={t("catalog.monthlyService.type")}
          value={billingMode}
          onValueChange={onBillingModeChange}
          options={[
            { value: "one_time", label: t("catalog.monthlyService.oneTime") },
            { value: "recurring", label: t("catalog.monthlyService.recurring") },
          ]}
        />
        {billingMode === "recurring" ? (
          <>
            <Select
              label={t("catalog.monthlyService.period")}
              value="month"
              options={[
                { value: "month", label: t("catalog.monthlyService.month") },
                {
                  value: "year",
                  label: t("catalog.monthlyService.yearUnavailable"),
                  disabled: true,
                },
              ]}
            />
            <Input
              label={t("catalog.monthlyService.includedMinutes")}
              inputMode="numeric"
              value={value.includedMinutes}
              onChange={(event) => change("includedMinutes", event.target.value)}
              {...(errors.includedMinutes ? { error: errors.includedMinutes } : {})}
              required
            />
            <Textarea
              label={t("catalog.monthlyService.scopeRu")}
              value={value.scopeRu}
              onChange={(event) => change("scopeRu", event.target.value)}
              rows={3}
              required
            />
            <Textarea
              label={t("catalog.monthlyService.scopeEn")}
              value={value.scopeEn}
              onChange={(event) => change("scopeEn", event.target.value)}
              rows={3}
            />
            <Input
              label={t("catalog.monthlyService.operatingHoursRu")}
              value={value.operatingHoursRu}
              onChange={(event) => change("operatingHoursRu", event.target.value)}
            />
            <Input
              label={t("catalog.monthlyService.operatingHoursEn")}
              value={value.operatingHoursEn}
              onChange={(event) => change("operatingHoursEn", event.target.value)}
            />
            <Textarea
              label={t("catalog.monthlyService.schedulingTermsRu")}
              value={value.schedulingTermsRu}
              onChange={(event) => change("schedulingTermsRu", event.target.value)}
              rows={2}
            />
            <Textarea
              label={t("catalog.monthlyService.schedulingTermsEn")}
              value={value.schedulingTermsEn}
              onChange={(event) => change("schedulingTermsEn", event.target.value)}
              rows={2}
            />
          </>
        ) : null}
      </div>
      {billingMode === "recurring" ? (
        <>
          {errors.scopeRu || errors.scopeEn ? (
            <Alert tone="error">{errors.scopeRu ?? errors.scopeEn}</Alert>
          ) : null}
          <Alert tone="info">
            <p>{t("catalog.monthlyService.noCarryover")}</p>
            <p>{t("catalog.monthlyService.externalApproval")}</p>
            <p>{t("catalog.monthlyService.annualUnavailable")}</p>
          </Alert>
        </>
      ) : null}
    </fieldset>
  );
}
