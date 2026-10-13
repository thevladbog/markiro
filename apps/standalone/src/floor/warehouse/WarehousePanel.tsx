import type { ReactNode } from "react";

import { Button } from "@markiro/ui";

export interface WarehousePanelProps {
  /** The id of the panel's heading: the section is named by it. */
  titleId: string;
  title: ReactNode;
  backLabel: string;
  /** The back button's handlers and state (the screen's guard after a change of view). */
  back: Record<string, unknown>;
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * One question of the reprint (a reason, the templates, a typed code, the finish) in the
 * cloud station's full-screen dialog layout (`FullScreenDialog` of @markiro/ui as
 * apps/station/src/pages/WarehouseReprint.tsx opens it): its title with «Отмена» across the
 * top, the question, its answer at the bottom right. It stays inside the floor's frame and
 * keeps the screen's own guard and focus, so it is laid out here rather than portalled.
 */
export function WarehousePanel({
  titleId,
  title,
  backLabel,
  back,
  footer,
  children,
}: WarehousePanelProps) {
  return (
    <section className="warehouse-panel" aria-labelledby={titleId}>
      <header className="warehouse-panel__header">
        <h2 id={titleId}>{title}</h2>
        <Button size="floor" variant="secondary" type="button" {...back}>
          {backLabel}
        </Button>
      </header>
      <div className="warehouse-panel__body">{children}</div>
      {footer === undefined ? null : <footer className="warehouse-panel__footer">{footer}</footer>}
    </section>
  );
}
