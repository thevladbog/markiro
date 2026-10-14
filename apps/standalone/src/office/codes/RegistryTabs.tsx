import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";

import { DataTabs } from "@markiro/ui";

import {
  registryHref,
  REGISTRY_PATHS,
  useRegistryMemory,
  type RegistryTab,
} from "./CodesSection.js";

const TABS = Object.keys(REGISTRY_PATHS) as RegistryTab[];

/**
 * The parts of «Поиск кодов» as the cloud draws them (data tabs): the one
 * open writes down its filters as it is left, and a part opened from
 * another finds them again.
 */
export function RegistryTabs({ active }: { active: RegistryTab }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const memory = useRegistryMemory();
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    memory.searches.set(active, location.search);
    memory.last.tab = active;
  }, [active, location.search, memory]);
  // A part is a page of its own: the tab chosen on the page before is focused again on this one.
  // The shell moves the focus to the page on every navigation; this waits for it to be done.
  useEffect(() => {
    if (!memory.focusTab.pending) return;
    const timer = setTimeout(() => {
      memory.focusTab.pending = false;
      wrapper.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [memory]);
  return (
    <div ref={wrapper}>
      <DataTabs
        label={t("office.registry.label")}
        activeId={active}
        items={TABS.map((tab) => ({ id: tab, label: t(`office.registry.${tab}`) }))}
        onChange={(tab) => {
          if (tab === active) return;
          memory.focusTab.pending = true;
          void navigate(registryHref(memory, tab));
        }}
      />
    </div>
  );
}
