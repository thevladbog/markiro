import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { Button, IconButton, useTheme } from "@markiro/ui";

import { useAuthClient } from "../auth/client.js";
import { useClearAuthQueryCache } from "../query/AuthQueryBoundary.js";
import { useActiveOrg } from "./useActiveOrg.js";

/**
 * Global top bar, rendered once by `AppShell` above the routed `<Outlet/>`
 * content -- distinct from the per-page `PageHeader` (`@markiro/ui`) each
 * route stub renders for its own title. Shows the active organization, the
 * signed-in user's email, a light/dark theme toggle, a RU/EN language
 * toggle, and sign-out.
 */
export function Header() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const authClient = useAuthClient();
  const clearAuthQueryCache = useClearAuthQueryCache();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const { theme, setTheme } = useTheme();
  const { orgName } = useActiveOrg();
  const { data: session } = authClient.useSession();

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    clearAuthQueryCache();
    try {
      await authClient.signOut();
    } finally {
      void navigate("/login", { replace: true });
    }
  };

  const handleToggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  const nextLanguage = i18n.language === "ru" ? "en" : "ru";
  const handleToggleLanguage = () => {
    void i18n.changeLanguage(nextLanguage);
  };

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "12px 24px",
        borderBottom: "1px solid var(--line)",
        background: "var(--surface-page)",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span
          style={{
            font: "600 14px/18px var(--font-ui)",
            color: "var(--fg-1)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {orgName ?? t("shell.header.noOrgName")}
        </span>
        <span
          style={{
            font: "400 12px/16px var(--font-ui)",
            color: "var(--fg-3)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {session?.user.email}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <IconButton
          aria-label={t("shell.header.toggleTheme")}
          variant="secondary"
          size="compact"
          icon={<span aria-hidden="true">{theme === "dark" ? "🌙" : "☀️"}</span>}
          onClick={handleToggleTheme}
        />
        <IconButton
          aria-label={t("shell.header.toggleLanguage")}
          variant="secondary"
          size="compact"
          icon={<span aria-hidden="true">{nextLanguage.toUpperCase()}</span>}
          onClick={handleToggleLanguage}
        />
        <Button
          variant="secondary"
          size="compact"
          loading={isSigningOut}
          onClick={() => void handleSignOut()}
        >
          {t("common.signOut")}
        </Button>
      </div>
    </header>
  );
}
