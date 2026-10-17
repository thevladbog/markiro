import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { TFunction } from "i18next";

import { Button, Modal, StatusChip } from "@markiro/ui";

import { OfficeIcon } from "../OfficeIcon.js";
import { BlockError, PanelHead, Skel } from "./blocks.js";
import type { AttentionItem } from "./dashboard-model.js";
import { Glyph } from "./OverviewIcon.js";
import type { BlockState } from "./use-overview-data.js";

/** How many rows a roomy window shows; a low window shows `SHOWN_COMPACT` (the CSS hides the rest). */
const SHOWN = 4;

/** The values of an item's text, with a span (`unit`, `count`) written out as `duration`. */
function textValues(
  values: Record<string, string | number>,
  t: TFunction,
): Record<string, string | number> {
  const { unit, count, ...rest } = values;
  if (typeof unit !== "string" || typeof count !== "number") return values;
  return { ...rest, duration: t(`office.overview.duration.${unit}`, { count }) };
}

function AttentionRow({ item, onGo }: { item: AttentionItem; onGo: (to: string) => void }) {
  const { t } = useTranslation();
  const title = t(item.titleKey, textValues(item.titleValues, t));
  const detail =
    item.detailKey === null ? null : t(item.detailKey, textValues(item.detailValues, t));
  return (
    <li className={`ov-attn__row ov-attn__row--${item.severity}`} data-attention={item.kind}>
      <span className="ov-attn__icon">
        {item.severity === "err" ? (
          <OfficeIcon name="warning" size={22} />
        ) : (
          <Glyph name="alertCircle" size={22} />
        )}
      </span>
      <div className="ov-attn__text">
        <strong>
          <span className="ov-visually-hidden">
            {t(`office.overview.attention.severity.${item.severity}`)}:{" "}
          </span>
          {title}
        </strong>
        {detail !== null && <span>{detail}</span>}
      </div>
      {item.to !== null && item.actionKey !== null && (
        <Button
          variant="secondary"
          onClick={() => onGo(item.to ?? "/")}
          aria-label={`${t(item.actionKey)}: ${title}`}
        >
          {t(item.actionKey)}
        </Button>
      )}
    </li>
  );
}

export interface AttentionPanelProps {
  state: BlockState;
  error: unknown;
  onRetry: () => void;
  items: readonly AttentionItem[];
  /** The line under a calm list: what is in order. */
  calm: string;
  /** Some of the checks could not be read: the list says so and offers to read again. */
  partial: boolean;
}

/**
 * «Требует внимания»: the exceptions, most serious first, each with the button that goes to it.
 * Only what needs a person; the steady state of devices, copies and license is «Состояние
 * системы». More than the window shows opens in a panel («Все (N)») instead of stretching the page.
 */
export function AttentionPanel({
  state,
  error,
  onRetry,
  items,
  calm,
  partial,
}: AttentionPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [all, setAll] = useState(false);
  const title = t("office.overview.attention.title");
  const icon = <Glyph name="alertCircle" size={20} />;
  if (state === "loading") {
    return (
      <section className="ov-panel ov-attn" aria-busy="true" aria-label={title}>
        <PanelHead icon={icon} title={title} />
        <ul className="ov-attn__list" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <li className="ov-attn__row" key={index}>
              <Skel className="ov-skel--dot" />
              <div className="ov-attn__text">
                <Skel className="ov-skel--title" />
                <Skel className="ov-skel--line" />
              </div>
              <Skel className="ov-skel--button" />
            </li>
          ))}
        </ul>
      </section>
    );
  }
  if (state === "error") {
    return (
      <section className="ov-panel ov-attn" aria-label={title}>
        <PanelHead icon={icon} title={title} />
        <BlockError
          title={t("office.overview.attention.errorTitle")}
          error={error}
          onRetry={onRetry}
        />
      </section>
    );
  }
  const go = (to: string) => {
    setAll(false);
    void navigate(to);
  };
  const shown = items.slice(0, SHOWN);
  return (
    <section className="ov-panel ov-attn" aria-label={title}>
      <PanelHead icon={icon} title={title}>
        {items.length > 3 ? (
          <Button
            variant="ghost"
            size="compact"
            className="ov-panel__link"
            onClick={() => setAll(true)}
          >
            {t("office.overview.attention.all", { count: items.length })}
            <OfficeIcon name="arrowRight" size={16} />
          </Button>
        ) : (
          items.length > 0 && (
            <StatusChip
              phase="attention"
              label={items.length}
              aria-label={`${title}: ${items.length}`}
            />
          )
        )}
      </PanelHead>
      <ul className="ov-attn__list">
        {shown.map((item) => (
          <AttentionRow key={item.id} item={item} onGo={go} />
        ))}
        {partial && (
          <li className="ov-attn__row ov-attn__row--partial">
            <BlockError
              title={t("office.overview.attention.errorTitle")}
              error={error}
              onRetry={onRetry}
            />
          </li>
        )}
        {items.length === 0 && !partial && (
          <li className="ov-attn__row ov-attn__row--calm">
            <span className="ov-attn__icon ov-attn__icon--ok">
              <Glyph name="checkCircle" size={22} />
            </span>
            <div className="ov-attn__text">
              <span>{calm}</span>
            </div>
          </li>
        )}
      </ul>
      {items.length === 1 && !partial && (
        <p className="ov-attn__calm">
          <Glyph name="checkCircle" size={16} />
          <span>{calm}</span>
        </p>
      )}
      <Modal
        open={all}
        title={t("office.overview.attention.allTitle")}
        onClose={() => setAll(false)}
        closeLabel={t("office.overview.attention.close")}
        width={560}
      >
        <ul className="ov-attn__list ov-attn__list--modal">
          {items.map((item) => (
            <AttentionRow key={item.id} item={item} onGo={go} />
          ))}
        </ul>
      </Modal>
    </section>
  );
}
