import { createContext, use, useState, type MouseEvent } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";

/** The parts of «Поиск кодов» (plan КРТ): codes, boxes and pallets. */
export type RegistryTab = "codes" | "boxes" | "pallets";

export const REGISTRY_PATHS: Record<RegistryTab, string> = {
  codes: "/codes",
  boxes: "/codes/boxes",
  pallets: "/codes/pallets",
};

/**
 * What the section remembers: the last `?…` each part was left with, so a
 * part found again finds its filters (the cloud keeps them in the browser's
 * session storage; the office is one session of one memory router, so the
 * section's own state is its session), and the part the user was last on.
 */
interface RegistryMemory {
  searches: Map<RegistryTab, string>;
  last: { tab: RegistryTab };
  /** A tab was chosen from the keyboard or the mouse: the part it opens takes the focus on its own tab. */
  focusTab: { pending: boolean };
}

const Memory = createContext<RegistryMemory | null>(null);

export function useRegistryMemory(): RegistryMemory {
  const memory = use(Memory);
  if (memory === null) throw new Error("the registry memory is read outside «Поиск кодов»");
  return memory;
}

/** Where a part is opened from another: its path with the filters it was left with. */
export function registryHref(memory: RegistryMemory, tab: RegistryTab): string {
  return `${REGISTRY_PATHS[tab]}${memory.searches.get(tab) ?? ""}`;
}

/**
 * A card's «Назад»: the page before it, or, when it was opened with no page
 * before (a link from outside the section), the last part with its filters.
 * `href` is the link's own address; `onClick` takes the page before when
 * there is one.
 */
export function useBackToRegistry(): {
  href: string;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
} {
  const navigate = useNavigate();
  const location = useLocation();
  const memory = useRegistryMemory();
  return {
    href: registryHref(memory, memory.last.tab),
    onClick: (event) => {
      if (location.key === "default") return;
      event.preventDefault();
      void navigate(-1);
    },
  };
}

/**
 * «Поиск кодов» as one section (plan КРТ): «Коды», «Короба» and «Паллеты»
 * as parts of one menu item, and the cards of a box and a pallet under it.
 */
export function CodesSection() {
  const [memory] = useState<RegistryMemory>(() => ({
    searches: new Map(),
    last: { tab: "codes" },
    focusTab: { pending: false },
  }));
  return (
    <Memory value={memory}>
      <Outlet />
    </Memory>
  );
}
