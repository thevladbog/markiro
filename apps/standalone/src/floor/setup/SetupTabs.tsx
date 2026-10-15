import type { ReactNode } from "react";

import { DataTabs } from "@markiro/ui";

/**
 * The setup's panels, in the cloud station's order, with the scanner's check beside the
 * scanner (beta 3.2: under the connection it was out of the screen's reach).
 */
export type SetupTabId = "scanner" | "check" | "printer" | "sound";

export interface SetupTab {
  id: SetupTabId;
  label: string;
  panel: ReactNode;
}

export interface SetupTabsProps {
  tabs: readonly SetupTab[];
  activeTab: SetupTabId;
  onTabChange: (tab: SetupTabId) => void;
  /** The tablist's name for a reader. */
  label: string;
  /** A tab that cannot be left now (a printer's form is open): the other tabs are off. */
  locked?: boolean;
}

/**
 * The cloud station's segmented setup tabs (apps/station/src/ui/setup/SetupTabs.tsx), on the
 * kit's `DataTabs` (arrows, Home and End move between them) dressed as the cloud's pill
 * control; only the active panel is in the page.
 */
export function SetupTabs({ tabs, activeTab, onTabChange, label, locked = false }: SetupTabsProps) {
  const active = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  if (!active) return null;
  return (
    <div className="setup-tabs">
      <DataTabs
        className="setup-tabs__list"
        label={label}
        items={tabs.map((tab) => ({
          id: tab.id,
          label: tab.label,
          panelId: `setup-panel-${tab.id}`,
          disabled: locked && tab.id !== active.id,
        }))}
        activeId={active.id}
        onChange={onTabChange}
      />
      <section
        className="setup-tabs__panel"
        id={`setup-panel-${active.id}`}
        role="tabpanel"
        aria-label={active.label}
      >
        {active.panel}
      </section>
    </div>
  );
}
