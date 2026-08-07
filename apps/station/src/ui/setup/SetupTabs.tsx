import { useRef, type KeyboardEvent, type ReactNode } from "react";

export type SetupTabId = "scanner" | "printer" | "sound";

export interface SetupTab {
  id: SetupTabId;
  label: string;
  panel: ReactNode;
}

export interface SetupTabsProps {
  tabs: readonly SetupTab[];
  activeTab: SetupTabId;
  onTabChange: (tab: SetupTabId) => void;
}

/** Accessible, direct-access navigation for the three bounded setup panels. */
export function SetupTabs({ tabs, activeTab, onTabChange }: SetupTabsProps) {
  const tabRefs = useRef(new Map<SetupTabId, HTMLButtonElement>());
  const active = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];

  if (!active) return null;

  function selectAndFocus(index: number) {
    const tab = tabs[index];
    if (!tab) return;
    onTabChange(tab.id);
    tabRefs.current.get(tab.id)?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % tabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    selectAndFocus(nextIndex);
  }

  return (
    <div className="setup-tabs">
      <div className="setup-tabs__list" role="tablist">
        {tabs.map((tab, index) => {
          const selected = tab.id === active.id;
          return (
            <button
              key={tab.id}
              ref={(node) => {
                if (node) tabRefs.current.set(tab.id, node);
                else tabRefs.current.delete(tab.id);
              }}
              id={`setup-tab-${tab.id}`}
              className="setup-tabs__tab"
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`setup-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onTabChange(tab.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <section
        className="setup-tabs__panel"
        id={`setup-panel-${active.id}`}
        role="tabpanel"
        aria-labelledby={`setup-tab-${active.id}`}
        tabIndex={0}
      >
        {active.panel}
      </section>
    </div>
  );
}
