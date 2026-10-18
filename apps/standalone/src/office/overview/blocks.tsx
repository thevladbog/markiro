import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

import { errorMessageKey } from "../../host/errors.js";
import { OverviewIcon } from "./OverviewIcon.js";

/** A grey bar of a skeleton: decorative, it carries no text. */
export function Skel({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span
      className={className === undefined ? "ov-skel" : `ov-skel ${className}`}
      style={style}
      aria-hidden="true"
    />
  );
}

export interface BlockErrorProps {
  title: string;
  error: unknown;
  onRetry: () => void;
  /** The error beside the title in one row (the strip), or centred under it (the chart). */
  layout?: "row" | "center";
}

/**
 * One block that did not load: what it is, the host's reason (its code, as every error of the
 * office names it) and «Повторить»; the other blocks stand untouched.
 */
export function BlockError({ title, error, onRetry, layout = "row" }: BlockErrorProps) {
  const { t } = useTranslation();
  return (
    <div className={`ov-error ov-error--${layout}`} role="group" aria-label={title}>
      <OverviewIcon name="alertCircle" size={24} className="ov-error__icon" />
      <div className="ov-error__text">
        <strong>{title}</strong>
        <span>{t(errorMessageKey(error))}</span>
      </div>
      <Button variant="secondary" size="compact" onClick={onRetry}>
        {t("office.common.retry")}
      </Button>
    </div>
  );
}

/** A panel's heading row: an icon, the title (a real heading) and what stands at the right. */
export function PanelHead({
  icon,
  title,
  children,
  id,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  id?: string;
}) {
  return (
    <div className="ov-panel__head">
      <span className="ov-panel__icon">{icon}</span>
      <h2 className="ov-panel__title" {...(id === undefined ? {} : { id })}>
        {title}
      </h2>
      {children}
    </div>
  );
}
