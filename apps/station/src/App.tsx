import { useTranslation } from "react-i18next";

export function App() {
  const { t } = useTranslation();
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <h1 style={{ fontSize: "2.5rem" }}>{t("app.title")}</h1>
    </main>
  );
}
