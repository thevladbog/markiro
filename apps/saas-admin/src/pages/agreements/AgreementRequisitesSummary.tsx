import { DefinitionGrid, type DefinitionGridItem } from "@markiro/ui";
import { useTranslation } from "react-i18next";

import type { RequisitesDraft } from "./AgreementRequisitesForm.js";

/**
 * Compact read-only view of the requisites for an agreement that can no longer
 * be edited: label and value pairs instead of a wall of disabled inputs. Empty
 * optional values stay visible as a muted dash so a missing field is noticed.
 */
export function AgreementRequisitesSummary({ value }: { value: RequisitesDraft }) {
  const { t } = useTranslation();
  const field = (id: keyof RequisitesDraft, label: string, mono = false): DefinitionGridItem => ({
    id,
    term: label,
    description: value[id] === "" ? <span className="agreement-muted">—</span> : String(value[id]),
    mono,
  });
  const counterparty: DefinitionGridItem[] = [
    {
      id: "kind",
      term: t("agreements.fields.kind"),
      description: t(`agreements.kinds.${value.kind}`),
    },
    field("name", t("agreements.fields.name")),
    field("inn", t("agreements.fields.inn"), true),
    ...(value.kind === "legal_entity"
      ? [
          field("kpp", t("agreements.fields.kpp"), true),
          field("ogrn", t("agreements.fields.ogrn"), true),
        ]
      : []),
    ...(value.kind === "sole_proprietor"
      ? [field("ogrnip", t("agreements.fields.ogrnip"), true)]
      : []),
  ];
  const contacts = [
    field("address", t("agreements.fields.address")),
    field("email", t("agreements.fields.email")),
    field("phone", t("agreements.fields.phone")),
  ];
  const bank = [
    field("bankName", t("agreements.fields.bankName")),
    field("bic", t("agreements.fields.bic"), true),
    field("settlementAccount", t("agreements.fields.settlementAccount"), true),
    field("correspondentAccount", t("agreements.fields.correspondentAccount"), true),
  ];
  return (
    <div className="agreement-summary">
      {(
        [
          ["counterparty", counterparty],
          ["address", contacts],
          ["bank", bank],
        ] as const
      ).map(([key, items]) => (
        <section key={key} className="agreement-summary__group">
          <h3 className="agreement-group__title">{t(`agreements.sections.${key}`)}</h3>
          <DefinitionGrid className="agreement-summary__grid" items={items} />
        </section>
      ))}
    </div>
  );
}
