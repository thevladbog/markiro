import { createContext, useContext, type ReactNode } from "react";

import { SidePanel, type OverlayDismissReason } from "@markiro/ui";

import { useNavigationGuard } from "../../layout/NavigationGuard.js";

const CatalogDrawerCloseContext = createContext<(() => void) | null>(null);

export function useCatalogDrawerClose(fallback: () => void): () => void {
  return useContext(CatalogDrawerCloseContext) ?? fallback;
}

export function CatalogDrawer({
  title,
  description,
  dirty,
  busy,
  onClose,
  children,
  closeLabel,
}: {
  title: string;
  description?: string;
  dirty: boolean;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
  closeLabel: string;
}) {
  const guard = useNavigationGuard(dirty, busy);
  const requestClose = (_reason: OverlayDismissReason) => {
    guard.requestProtectedAction(onClose);
  };
  return (
    <SidePanel
      open
      title={title}
      {...(description ? { description } : {})}
      size="complex"
      busy={busy}
      closeLabel={closeLabel}
      onClose={requestClose}
    >
      <CatalogDrawerCloseContext.Provider
        value={() => guard.requestProtectedAction(onClose)}
      >
        {children}
      </CatalogDrawerCloseContext.Provider>
    </SidePanel>
  );
}
