import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

export interface KioskLayoutProps {
  status?: ReactNode;
  children: ReactNode;
  onActivity?: () => void;
}

export interface KioskViewport {
  width: number;
  height: number;
}

export function supportsKioskViewport(width: number, height: number): boolean {
  return (width >= 480 && height >= 800) || (width >= 800 && height >= 480);
}

function currentViewport(): KioskViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function KioskLayout({ status, children, onActivity }: KioskLayoutProps): React.JSX.Element {
  const { t } = useTranslation();
  const [viewport, setViewport] = useState(currentViewport);

  useEffect(() => {
    const measure = () => setViewport(currentViewport());
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  if (!supportsKioskViewport(viewport.width, viewport.height)) {
    return (
      <div className="kiosk-shell">
        <main className="kiosk-screen kiosk-unsupported" role="alert">
          <strong className="kiosk-unsupported__measure">
            {t("layout.viewport", { width: viewport.width, height: viewport.height })}
          </strong>
          <h1>{t("layout.tooSmallTitle")}</h1>
          <p>{t("layout.tooSmallBody")}</p>
        </main>
      </div>
    );
  }

  return (
    <div className="kiosk-shell" onPointerDown={onActivity} onKeyDown={onActivity}>
      {status}
      <div className="kiosk-screen-slot">{children}</div>
    </div>
  );
}
