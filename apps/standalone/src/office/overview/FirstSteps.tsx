import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { Button, StatusChip } from "@markiro/ui";

import type { FirstStep, FirstStepId } from "./dashboard-model.js";
import { PanelHead } from "./blocks.js";
import { Glyph } from "./OverviewIcon.js";

const TARGET: Record<FirstStepId, string> = {
  profile: "/org",
  line: "/lines",
  station: "/devices",
  products: "/products",
  shift: "/shifts",
};

/**
 * «Первые шаги» for a site that has just been set up: what is done, and the one next step with
 * the button that goes to it. It takes the place of «Требует внимания» until there is something
 * to watch.
 */
export function FirstSteps({ steps }: { steps: readonly FirstStep[] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const done = steps.filter((step) => step.done === true).length;
  const next = steps.find((step) => step.done !== true && step.done !== null);
  return (
    <section className="ov-panel ov-attn" aria-label={t("office.overview.firstSteps.title")}>
      <PanelHead
        icon={<Glyph name="checklist" size={20} />}
        title={t("office.overview.firstSteps.title")}
      >
        <StatusChip
          phase="none"
          label={t("office.overview.firstSteps.progress", { done, total: steps.length })}
        />
      </PanelHead>
      <ol className="ov-attn__list">
        {steps.map((step) => (
          <li className="ov-attn__row" key={step.id} data-step={step.id}>
            <span
              className={step.done === true ? "ov-attn__icon ov-attn__icon--ok" : "ov-attn__icon"}
            >
              <Glyph name={step.done === true ? "checkCircle" : "circle"} size={22} />
            </span>
            <div className="ov-attn__text">
              <strong>{t(`office.overview.firstSteps.steps.${step.id}.title`)}</strong>
              {step.done !== true && (
                <span>{t(`office.overview.firstSteps.steps.${step.id}.hint`)}</span>
              )}
            </div>
            {step.done === true ? (
              <StatusChip phase="done" label={t("office.overview.firstSteps.done")} />
            ) : (
              next?.id === step.id && (
                <Button variant="secondary" onClick={() => void navigate(TARGET[step.id])}>
                  {t(`office.overview.firstSteps.steps.${step.id}.action`)}
                </Button>
              )
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
