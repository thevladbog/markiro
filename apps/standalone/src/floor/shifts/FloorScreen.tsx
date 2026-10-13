import { useId, type ReactNode, type Ref } from "react";

import { cn } from "@markiro/ui";

import "./shift-hub.css";

export interface FloorScreenProps {
  title: string;
  /** The title takes the focus when the screen asks for it (`tabIndex=-1`). */
  titleRef?: Ref<HTMLHeadingElement>;
  /** Beside the title: the operator, a message slot, a header action. */
  header?: ReactNode;
  /** The fixed action row under the content (`FloorFooter`). */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * One floor state laid out as the cloud station's `StationScreen`
 * (apps/station/src/ui/StationScreen.tsx): the title row, the content, the
 * fixed action row. A `section`, not a `main`: the app's shell already owns
 * the page's `main`.
 */
export function FloorScreen({
  title,
  titleRef,
  header,
  actions,
  className,
  children,
}: FloorScreenProps) {
  const titleId = useId();
  return (
    <section className={cn("station-screen", className)} aria-labelledby={titleId}>
      <header className="station-screen__header">
        <h2 id={titleId} ref={titleRef} tabIndex={titleRef === undefined ? undefined : -1}>
          {title}
        </h2>
        {header}
      </header>
      <div className="station-screen__content">{children}</div>
      {actions ? <div className="station-screen__actions">{actions}</div> : null}
    </section>
  );
}

export interface FloorFooterProps {
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}

/** The cloud station's `FloorFooter`: the fixed floor action row. */
export function FloorFooter({ ariaLabel, className, children }: FloorFooterProps) {
  return (
    <footer className={cn("station-floor-footer", className)} aria-label={ariaLabel}>
      {children}
    </footer>
  );
}
