import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

export type EmployeeSectionId = "profile" | "pickup-policy" | "badges" | "station-access";

export interface EmployeeSectionNavItem {
  id: EmployeeSectionId;
  label: string;
  meta?: ReactNode;
  hasError: boolean;
}

export interface EmployeeSectionNavProps {
  items: EmployeeSectionNavItem[];
  activeId: EmployeeSectionId;
  onNavigate: (id: EmployeeSectionId) => void;
}

export function EmployeeSectionNav({ items, activeId, onNavigate }: EmployeeSectionNavProps) {
  const { t } = useTranslation();

  return (
    <nav
      className="mk-employee-section-nav"
      aria-label={t("pages.employees.sections.navigationLabel")}
    >
      <ul className="mk-employee-section-nav__list">
        {items.map((item) => (
          <li key={item.id} className="mk-employee-section-nav__item">
            <Button
              type="button"
              size="compact"
              variant={item.id === activeId ? "primary" : "secondary"}
              className="mk-employee-section-nav__button"
              aria-current={item.id === activeId ? "location" : undefined}
              onClick={() => onNavigate(item.id)}
            >
              <span className="mk-employee-section-nav__label">{item.label}</span>
              {item.meta !== undefined || item.hasError ? (
                <span className="mk-employee-section-nav__markers">
                  {item.meta !== undefined ? (
                    <span className="mk-employee-section-nav__meta">{item.meta}</span>
                  ) : null}
                  {item.hasError ? (
                    <span className="mk-employee-section-nav__error">
                      {t("pages.employees.sections.error")}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </Button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
