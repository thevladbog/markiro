import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";

import { PageHeader } from "@markiro/ui";

import { useOfficeSession } from "../office-session.js";
import { ABOUT_SECTIONS } from "./sections.js";

/**
 * «Информация»: what this program is and whom to ask about it. The sections
 * (`ABOUT_SECTIONS`) follow a table of contents of plain links to their
 * anchors, so the page reads as a whole and a section is one Tab away.
 */
export function AboutPage() {
  const { t } = useTranslation();
  const role = useOfficeSession().user.role;
  const sections = ABOUT_SECTIONS.filter((section) => section.roles.includes(role));
  const location = useLocation();
  useEffect(() => {
    // A link to a section's anchor (the license band, plan ЛЦ-3) brings that
    // section into view with the focus, so a keyboard and a screen reader start there.
    if (location.hash === "") return;
    let id: string;
    try {
      id = decodeURIComponent(location.hash.slice(1));
    } catch {
      // A malformed anchor (`#%E0`) names no section: the page opens at its top.
      return;
    }
    document.getElementById(id)?.focus();
  }, [location.hash, location.key]);
  return (
    <>
      <PageHeader title={t("office.about.title")} description={t("office.about.subtitle")} />
      <nav aria-label={t("office.about.toc")}>
        <ul className="office-toc">
          {sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                {...(location.hash === `#${section.id}` ? { "aria-current": "location" } : {})}
              >
                {t(section.titleKey)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {sections.map(({ id, Component }) => (
        <div key={id} id={id} tabIndex={-1} className="office-stack">
          <Component />
        </div>
      ))}
    </>
  );
}
