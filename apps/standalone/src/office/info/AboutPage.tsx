import { useTranslation } from "react-i18next";

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
  return (
    <>
      <PageHeader title={t("office.about.title")} />
      <nav aria-label={t("office.about.toc")}>
        <ul className="office-toc">
          {sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{t(section.titleKey)}</a>
            </li>
          ))}
        </ul>
      </nav>
      {sections.map(({ id, Component }) => (
        <div key={id} id={id}>
          <Component />
        </div>
      ))}
    </>
  );
}
