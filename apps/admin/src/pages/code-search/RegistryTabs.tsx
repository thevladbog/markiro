import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { DataTabs } from "@markiro/ui";

import { registryHref, type RegistryTab } from "./registry-location.js";
import { useRememberRegistryLocation } from "./useRememberRegistryLocation.js";

/**
 * Segmented switch between the three code-search registries. The pages stay
 * separate routes (`/codes`, `/boxes`, `/pallets`) -- deep links and the
 * code/box/pallet cards' back actions keep working unchanged -- and only the
 * sidebar entry was collapsed into the single "Поиск кодов" item, so this
 * switch is the sole navigation between them.
 *
 * Each registry keeps its filters in the URL query, and mounting this switch
 * records the page's current address (`useRememberRegistryLocation`), so a
 * switch to another tab lands on that tab's last filters rather than a blank
 * registry, and a card's «← Поиск кодов» returns to the tab it came from.
 */
export function RegistryTabs({ active }: { active: RegistryTab }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useRememberRegistryLocation(active);

  return (
    <DataTabs
      items={[
        { id: "codes", label: t("pages.codeSearch.tabs.codes") },
        { id: "boxes", label: t("pages.codeSearch.tabs.boxes") },
        { id: "pallets", label: t("pages.codeSearch.tabs.pallets") },
      ]}
      activeId={active}
      onChange={(id) => {
        if (id !== active) void navigate(registryHref(id));
      }}
      label={t("pages.codeSearch.tabs.label")}
    />
  );
}
