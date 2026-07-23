import type { ReactNode } from "react";

import { Card } from "@markiro/ui";

/** Shared centered-card shell used by all four auth pages. */
export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: 96 }}>
      <Card title={title} style={{ width: 380 }}>
        {children}
      </Card>
    </div>
  );
}
