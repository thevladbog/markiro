import { useId, useRef, type CSSProperties, type KeyboardEvent } from "react";

import { cn } from "../cn.js";

export interface DataTabItem<Id extends string = string> {
  id: Id;
  label: string;
  panelId?: string;
  disabled?: boolean;
  count?: number | string;
}

export interface DataTabsProps<Id extends string = string> {
  items: readonly DataTabItem<Id>[];
  activeId: Id;
  onChange: (id: Id) => void;
  label: string;
  className?: string;
  style?: CSSProperties;
}

export function DataTabs<Id extends string>({
  items,
  activeId,
  onChange,
  label,
  className,
  style,
}: DataTabsProps<Id>) {
  const tabListId = useId();
  const tabRefs = useRef(new Map<Id, HTMLButtonElement>());

  function move(event: KeyboardEvent<HTMLButtonElement>, currentId: Id) {
    const enabled = items.filter((item) => !item.disabled);
    const currentIndex = enabled.findIndex((item) => item.id === currentId);
    if (currentIndex < 0) return;
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % enabled.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + enabled.length) % enabled.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = enabled.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = enabled[nextIndex];
    if (!next) return;
    onChange(next.id);
    tabRefs.current.get(next.id)?.focus();
  }

  return (
    <div
      className={cn("mk-data-tabs", "mk-motion-safe", className)}
      role="tablist"
      aria-label={label}
      style={style}
    >
      {items.map((item) => {
        const selected = item.id === activeId;
        return (
          <button
            key={item.id}
            id={`${tabListId}-${item.id}`}
            ref={(node) => {
              if (node) tabRefs.current.set(item.id, node);
              else tabRefs.current.delete(item.id);
            }}
            className={cn("mk-data-tabs__tab", selected && "mk-data-tabs__tab--active")}
            type="button"
            role="tab"
            aria-label={item.label}
            aria-selected={selected}
            aria-controls={item.panelId}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => move(event, item.id)}
          >
            <span>{item.label}</span>
            {item.count !== undefined ? (
              <span className="mk-data-tabs__count">{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
