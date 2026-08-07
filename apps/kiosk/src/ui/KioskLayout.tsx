import type { ReactNode } from "react";

export interface KioskLayoutProps {
  status?: ReactNode;
  children: ReactNode;
}

export function KioskLayout({ status, children }: KioskLayoutProps): React.JSX.Element {
  return (
    <div className="kiosk-shell">
      {status}
      <div className="kiosk-screen-slot">{children}</div>
    </div>
  );
}
