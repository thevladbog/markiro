import { useId, type ReactNode } from "react";

export interface StationScreenProps {
  title: string;
  header?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

/** Fixed, non-scrolling layout for one station state. */
export function StationScreen({ title, header, actions, children }: StationScreenProps) {
  const titleId = useId();
  return (
    <main className="station-screen" aria-labelledby={titleId}>
      <header className="station-screen__header">
        <h1 id={titleId}>{title}</h1>
        {header}
      </header>
      <div className="station-screen__content">{children}</div>
      {actions ? <div className="station-screen__actions">{actions}</div> : null}
    </main>
  );
}
