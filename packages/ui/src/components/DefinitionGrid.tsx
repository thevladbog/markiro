import type { CSSProperties, ReactNode } from "react";

import { cn } from "../cn.js";

export interface DefinitionGridItem {
  id: string;
  term: ReactNode;
  description: ReactNode;
  mono?: boolean;
}

export interface DefinitionGridProps {
  items: readonly DefinitionGridItem[];
  className?: string;
  style?: CSSProperties;
}

export function DefinitionGrid({ items, className, style }: DefinitionGridProps) {
  return (
    <dl className={cn("mk-definition-grid", className)} style={style}>
      {items.map((item) => (
        <div className="mk-definition-grid__item" key={item.id}>
          <dt className="mk-definition-grid__term">{item.term}</dt>
          <dd className={cn("mk-definition-grid__description", item.mono && "font-mono")}>
            {item.description}
          </dd>
        </div>
      ))}
    </dl>
  );
}
