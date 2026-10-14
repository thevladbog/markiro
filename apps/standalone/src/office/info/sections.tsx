import type { ComponentType } from "react";

import type { OfficeRole } from "../../host/protocol.js";
import { ContactsSection } from "./ContactsSection.js";
import { LicenseSection } from "./LicenseSection.js";
import { ProgramSection } from "./ProgramSection.js";
import { SupportSection } from "./SupportSection.js";
import { UpdateSection } from "./UpdateSection.js";

/** One section of «Информация». */
export interface AboutSection {
  /** The anchor (`#id`) and the key of the section in the table of contents. */
  id: string;
  /** The i18n key of the title, in the table of contents. */
  titleKey: string;
  /** Who sees the section. */
  roles: readonly OfficeRole[];
  /** Draws the section's cards; it shows its own state when its data is missing. */
  Component: ComponentType;
}

const BOTH_ROLES: readonly OfficeRole[] = ["admin", "technologist"];

/**
 * The sections in the order the page prints them (extension point T1 of the
 * license and update spec): «Лицензия» stays second, and the update section
 * is added after it. A section that fails to read its data says so itself;
 * the page does not fall with it.
 */
export const ABOUT_SECTIONS: readonly AboutSection[] = [
  {
    id: "program",
    titleKey: "office.about.program.title",
    roles: BOTH_ROLES,
    Component: ProgramSection,
  },
  {
    id: "license",
    titleKey: "office.about.license.title",
    roles: BOTH_ROLES,
    Component: LicenseSection,
  },
  {
    id: "update",
    titleKey: "office.about.update.title",
    roles: BOTH_ROLES,
    Component: UpdateSection,
  },
  {
    id: "contacts",
    titleKey: "office.about.contacts.title",
    roles: BOTH_ROLES,
    Component: ContactsSection,
  },
  {
    id: "support",
    titleKey: "office.about.support.title",
    roles: BOTH_ROLES,
    Component: SupportSection,
  },
];
