import { useTranslation } from "react-i18next";
import type { Readiness, RegulatoryProfile } from "./api.js";

export function ReadinessPanel({
  readiness,
  profile,
}: {
  readiness: Readiness;
  profile: RegulatoryProfile | null;
}) {
  const { t } = useTranslation();
  const p = "pages.catalog.regulatory.";
  const reasonText = (reason: Readiness["dimensions"][number]["reasons"][number]) => {
    const label = profile?.definition?.attributes.find((a) => a.id === reason.attributeId)?.label;
    return t(p + "reasons." + reason.code, {
      defaultValue: t(p + "reasonUnknown"),
      field: label ?? t(p + "categoryAttribute"),
    });
  };
  return (
    <section
      className="mk-catalog-panel-section mk-regulatory"
      aria-labelledby="product-readiness-title"
    >
      <h3 id="product-readiness-title">{t(p + "readiness")}</h3>
      <p className="mk-regulatory-meta">{t(p + "readinessHint")}</p>
      <ul className="mk-readiness-list">
        {readiness.dimensions.map((item) => (
          <li key={item.dimension}>
            <div className="mk-readiness-heading">
              <strong>{t(p + "dimensions." + item.dimension)}</strong>
              <span className="mk-readiness-state" data-state={item.state}>
                {t(p + "states." + item.state)}
              </span>
            </div>
            {item.reasons.length > 0 && (
              <ul>
                {item.reasons.map((reason, index) => (
                  <li key={index}>{reasonText(reason)}</li>
                ))}
              </ul>
            )}
            {item.recommendations.length > 0 && (
              <ul className="mk-regulatory-meta">
                {item.recommendations.map((reason, index) => (
                  <li key={index}>{reasonText(reason)}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
