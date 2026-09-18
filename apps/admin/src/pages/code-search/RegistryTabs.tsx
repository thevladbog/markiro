import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { DataTabs } from "@markiro/ui";

type RegistryTab = "codes" | "boxes" | "pallets";

const TAB_ROUTES: Record<RegistryTab, string> = {
  codes: "/codes",
  boxes: "/boxes",
  pallets: "/pallets",
};

/**
 * Segmented switch between the three code-search registries. The pages stay
 * separate routes (`/codes`, `/boxes`, `/pallets`) -- deep links and the
 * code/box/pallet cards' back actions keep working unchanged -- and only the
 * sidebar entry was collapsed into the single "Поиск кодов" item, so this
 * switch is the sole navigation between them.
 */
export function RegistryTabs({ active }: { active: RegistryTab }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <DataTabs
      items={[
        { id: "codes", label: t("pages.codeSearch.tabs.codes") },
        { id: "boxes", label: t("pages.codeSearch.tabs.boxes") },
        { id: "pallets", label: t("pages.codeSearch.tabs.pallets") },
      ]}
      activeId={active}
      onChange={(id) => {
        if (id !== active) void navigate(TAB_ROUTES[id]);
      }}
      label={t("pages.codeSearch.tabs.label")}
    />
  );
}
