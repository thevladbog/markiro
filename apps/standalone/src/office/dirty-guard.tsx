import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Which open drawers hold edits that are not saved yet, so the header's
 * «Выйти» can ask before it throws them away. A drawer reports itself with
 * `useReportDirty`; outside the office shell the report goes nowhere.
 */
export interface DirtyRegistry {
  report: (id: string, dirty: boolean) => void;
  /** Whether any reporter is dirty right now. */
  anyDirty: () => boolean;
}

const NOWHERE: DirtyRegistry = { report: () => undefined, anyDirty: () => false };

const DirtyContext = createContext<DirtyRegistry>(NOWHERE);

/** A fresh registry that lives as long as the provider. */
export function DirtyGuardProvider({
  registry,
  children,
}: {
  registry: DirtyRegistry;
  children: ReactNode;
}) {
  return <DirtyContext value={registry}>{children}</DirtyContext>;
}

/** A registry backed by a set of ids; `useRef(createDirtyRegistry())` in the shell. */
export function createDirtyRegistry(): DirtyRegistry {
  const dirty = new Set<string>();
  return {
    report: (id, isDirty) => {
      if (isDirty) dirty.add(id);
      else dirty.delete(id);
    },
    anyDirty: () => dirty.size > 0,
  };
}

/** The shell's own registry, created once. */
export function useDirtyRegistry(): DirtyRegistry {
  const ref = useRef<DirtyRegistry | null>(null);
  ref.current ??= createDirtyRegistry();
  return ref.current;
}

/** Reports this component's dirt to the registry until it unmounts. */
export function useReportDirty(dirty: boolean): void {
  const registry = useContext(DirtyContext);
  const id = useId();
  useEffect(() => {
    registry.report(id, dirty);
    return () => registry.report(id, false);
  }, [registry, id, dirty]);
}
