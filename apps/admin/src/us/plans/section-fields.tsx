import { Button, Input, Select, Textarea } from "@markiro/ui";
import type { UsPlanSectionsBody } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";

export const sectionIds = [
  "recordMaintenance",
  "ftlIdentification",
  "tlcAssignment",
  "pointOfContact",
  "farmActivity",
  "reviewAndUpdate",
] as const;
export type SectionId = (typeof sectionIds)[number];
export function emptyPlanSections(): UsPlanSectionsBody {
  return {
    recordMaintenance: {
      systemOfRecord: "",
      formats: [],
      recordLocations: [],
      responsibleRoles: [],
      backupAndRecovery: "",
      narrative: [],
    },
    ftlIdentification: { procedure: "", reviewCadence: "" },
    tlcAssignment: { procedure: "" },
    pointOfContact: { name: "", title: "", phone: "", email: null },
    farmActivity: { status: "unknown", explanation: "" },
    reviewAndUpdate: { procedure: "" },
  };
}
export function SectionFields({
  section,
  sections,
  onChange,
  disabled,
}: {
  section: SectionId;
  sections: UsPlanSectionsBody;
  onChange: (value: UsPlanSectionsBody) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  function update<K extends SectionId, F extends keyof UsPlanSectionsBody[K]>(
    group: K,
    field: F,
    value: UsPlanSectionsBody[K][F],
  ) {
    onChange({ ...sections, [group]: { ...sections[group], [field]: value } });
  }
  function text(field: string, value: string, change: (value: string) => void, short = false) {
    const props = {
      id: `us-plan-${section}-${field}`,
      label: t(`usPlan.fields.${field}`),
      value,
      disabled,
      maxLength: 4096,
      "aria-describedby": "us-plan-operator-help",
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        change(event.target.value),
    };
    return short ? <Input key={field} {...props} /> : <Textarea key={field} {...props} rows={3} />;
  }
  if (section === "recordMaintenance")
    return (
      <>
        {text(
          "systemOfRecord",
          sections.recordMaintenance.systemOfRecord,
          (value) => update(section, "systemOfRecord", value),
          true,
        )}
        {(["formats", "recordLocations", "responsibleRoles", "narrative"] as const).map((field) => (
          <fieldset key={field} className="us-plan-array">
            <legend>{t(`usPlan.fields.${field}`)}</legend>
            {sections.recordMaintenance[field].map((value, index) => (
              <div className="us-plan-array-row" key={index}>
                <Textarea
                  id={`us-plan-${field}-${index}`}
                  label={`${t(`usPlan.fields.${field}`)} ${index + 1}`}
                  value={value}
                  maxLength={4096}
                  disabled={disabled}
                  aria-describedby="us-plan-operator-help"
                  rows={2}
                  onChange={(event) =>
                    update(
                      section,
                      field,
                      sections.recordMaintenance[field].map((item, i) =>
                        i === index ? event.target.value : item,
                      ),
                    )
                  }
                />
                <Button
                  variant="secondary"
                  disabled={disabled}
                  onClick={() =>
                    update(
                      section,
                      field,
                      sections.recordMaintenance[field].filter((_, i) => i !== index),
                    )
                  }
                >
                  {t("usPlan.removeRow", { field: t(`usPlan.fields.${field}`), index: index + 1 })}
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              disabled={disabled || sections.recordMaintenance[field].length >= 50}
              onClick={() => update(section, field, [...sections.recordMaintenance[field], ""])}
            >
              {t("usPlan.addRow", { field: t(`usPlan.fields.${field}`) })}
            </Button>
          </fieldset>
        ))}
        {text("backupAndRecovery", sections.recordMaintenance.backupAndRecovery, (value) =>
          update(section, "backupAndRecovery", value),
        )}
      </>
    );
  if (section === "ftlIdentification")
    return (
      <>
        {text("procedure", sections.ftlIdentification.procedure, (value) =>
          update(section, "procedure", value),
        )}
        {text("reviewCadence", sections.ftlIdentification.reviewCadence, (value) =>
          update(section, "reviewCadence", value),
        )}
      </>
    );
  if (section === "pointOfContact")
    return (
      <>
        {(["name", "title", "phone", "email"] as const).map((field) =>
          text(
            field,
            sections.pointOfContact[field] ?? "",
            (value) => update(section, field, field === "email" && value === "" ? null : value),
            true,
          ),
        )}
      </>
    );
  if (section === "farmActivity")
    return (
      <>
        <Select
          native
          label={t("usPlan.fields.status")}
          value={sections.farmActivity.status}
          disabled={disabled}
          hint={t("usPlan.farmHelp")}
          options={(["unknown", "no", "yes"] as const).map((value) => ({
            value,
            label: t(`usPlan.values.${value}`),
          }))}
          onValueChange={(value) => update(section, "status", value)}
        />
        {sections.farmActivity.status !== "no" ? (
          <p role="status">{t("usPlan.farmBlocks")}</p>
        ) : null}
        {text("explanation", sections.farmActivity.explanation, (value) =>
          update(section, "explanation", value),
        )}
      </>
    );
  return text("procedure", sections[section].procedure, (value) =>
    update(section, "procedure", value),
  );
}
