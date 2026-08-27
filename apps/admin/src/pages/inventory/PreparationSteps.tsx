import { useTranslation } from "react-i18next";

const STEPS = ["parameters", "exports", "snapshot", "terminals", "launch"] as const;

export function PreparationSteps({ current }: { current: number }) {
  const { t } = useTranslation();

  return (
    <nav className="mk-inventory-steps" aria-label={t("pages.inventory.steps.label")}>
      <ol>
        {STEPS.map((step, index) => {
          const number = index + 1;
          const active = current === number;
          const complete = current > number;
          return (
            <li key={step} aria-current={active ? "step" : undefined}>
              <span className="mk-inventory-steps__number" aria-hidden="true">
                {complete ? "✓" : number}
              </span>
              <span>
                <small>{t("pages.inventory.steps.stage", { number })}</small>
                <strong>{t(`pages.inventory.steps.${step}`)}</strong>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
