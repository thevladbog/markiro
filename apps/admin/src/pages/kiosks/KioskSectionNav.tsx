import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

export type KioskSectionId = "profile" | "products";

export interface KioskSectionNavItem {
  id: KioskSectionId;
  label: string;
  meta?: string;
  hasError: boolean;
}

export interface KioskSectionNavProps {
  items: KioskSectionNavItem[];
  activeId: KioskSectionId;
  onActivate: (id: KioskSectionId) => void;
}

export function KioskSectionNav({ items, activeId, onActivate }: KioskSectionNavProps) {
  const { t } = useTranslation();

  return (
    <nav className="mk-kiosk-section-nav" aria-label={t("pages.kiosks.sections.navigationLabel")}>
      <ul className="mk-kiosk-section-nav__list">
        {items.map((item) => (
          <li key={item.id} className="mk-kiosk-section-nav__item">
            <Button
              type="button"
              size="compact"
              variant={item.id === activeId ? "primary" : "secondary"}
              className="mk-kiosk-section-nav__button"
              aria-current={item.id === activeId ? "location" : undefined}
              onClick={() => onActivate(item.id)}
            >
              <span className="mk-kiosk-section-nav__label">{item.label}</span>
              {item.meta !== undefined || item.hasError ? (
                <span className="mk-kiosk-section-nav__markers">
                  {item.meta !== undefined ? (
                    <span className="mk-kiosk-section-nav__meta">{item.meta}</span>
                  ) : null}
                  {item.hasError ? (
                    <span className="mk-kiosk-section-nav__error">
                      {t("pages.kiosks.sections.error")}
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
