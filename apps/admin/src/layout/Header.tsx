import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { Button, useTheme } from "@markiro/ui";

import { useAuthClient } from "../auth/client.js";
import { useActiveOrg } from "./useActiveOrg.js";

const ICON_BUTTON_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "var(--control-sm)",
  minWidth: "var(--control-sm)",
  padding: "0 10px",
  borderRadius: "var(--r-2)",
  border: "1px solid var(--line-strong)",
  background: "var(--surface-card)",
  color: "var(--fg-1)",
  font: "600 12px/1 var(--font-ui)",
  cursor: "pointer",
};

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
  const { theme, setTheme } = useTheme();
  const { orgName } = useActiveOrg();
  const { data: session } = authClient.useSession();

  const handleSignOut = () => {
    // Fake clients in tests don't reactively update `useSession()` after
    // `signOut()` resolves (unlike the real client's internal store), so the
    // redirect is driven explicitly here rather than relying on
    // `ShellPage`'s guard to react to a cleared session.
    void authClient.signOut().then(() => {
      void navigate("/login", { replace: true });
    });
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
        <button
          type="button"
          aria-label={t("shell.header.toggleTheme")}
          onClick={handleToggleTheme}
          style={ICON_BUTTON_STYLE}
        >
          {theme === "dark" ? "\u{1F319}" : "☀️"}
        </button>
        <button
          type="button"
          aria-label={t("shell.header.toggleLanguage")}
          onClick={handleToggleLanguage}
          style={ICON_BUTTON_STYLE}
        >
          {nextLanguage.toUpperCase()}
        </button>
        <Button variant="secondary" size="compact" onClick={handleSignOut}>
          {t("common.signOut")}
        </Button>
      </div>
    </header>
  );
}
