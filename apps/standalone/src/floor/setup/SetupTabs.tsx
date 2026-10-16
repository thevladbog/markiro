import type { ReactNode } from "react";

import { DataTabs } from "@markiro/ui";

/**
 * The setup's panels (design kit 2026-10): the printers and what goes on which, the scanners with
 * their check beside them, the sound, and the station itself. The scanner's check is a panel
 * inside «Сканеры», not a tab of its own.
 */
export type SetupTabId = "printer" | "scanner" | "sound" | "station";

export interface SetupTab {
  id: SetupTabId;
  label: string;
}

export interface SetupTabListProps {
  tabs: readonly SetupTab[];
  activeTab: SetupTabId;
  onTabChange: (tab: SetupTabId) => void;
  /** The tablist's name for a reader. */
  label: string;
  /** A tab that cannot be left now (a printer's form is open): the other tabs are off. */
  locked?: boolean;
}

/** The panel id of a tab, for `aria-controls`. */
export const setupPanelId = (tab: SetupTabId) => `setup-panel-${tab}`;

/**
 * The kit's segmented control as the setup's tabs: one `fg`-filled, checked, weight-600 segment
 * on the `panel` track. It is the kit's `DataTabs` (arrows, Home and End move between the tabs,
 * only the active tab is in the tab order); with a form open the other segments are `dis`.
 */
export function SetupTabList({
  tabs,
  activeTab,
  onTabChange,
  label,
  locked = false,
}: SetupTabListProps) {
  const active = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  if (!active) return null;
  return (
    <DataTabs
      className="setup-tabs__list"
      label={label}
      items={tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        panelId: setupPanelId(tab.id),
        disabled: locked && tab.id !== active.id,
      }))}
      activeId={active.id}
      onChange={onTabChange}
    />
  );
}

export interface SetupTabPanelProps {
  tab: SetupTab;
  children: ReactNode;
}

/** The active tab's panel; only the active panel is in the page. */
export function SetupTabPanel({ tab, children }: SetupTabPanelProps) {
  return (
    <section
      className="setup-tabs__panel"
      id={setupPanelId(tab.id)}
      role="tabpanel"
      aria-label={tab.label}
    >
      {children}
    </section>
  );
}
