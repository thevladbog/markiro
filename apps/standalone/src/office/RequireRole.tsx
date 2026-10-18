import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@markiro/ui";

import type { OfficeRole } from "../host/protocol.js";
import { useOfficeSession } from "./office-session.js";

export interface RequireRoleProps {
  roles: readonly OfficeRole[];
  children: ReactNode;
}

/**
 * A route only these roles may open (spec §4.8). The menu hides it from the
 * others; this covers a role that changed while the page was open. The host
 * enforces the rule itself.
 */
export function RequireRole({ roles, children }: RequireRoleProps) {
  const { t } = useTranslation();
  const { user } = useOfficeSession();
  if (roles.includes(user.role)) return <>{children}</>;
  return <EmptyState title={t("office.noAccess.title")} hint={t("office.noAccess.hint")} />;
}
