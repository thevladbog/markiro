import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useBlocker } from "react-router";

import { Alert, ConfirmDialog } from "@markiro/ui";

interface GuardState {
  dirty: boolean;
  busy: boolean;
}

interface NavigationGuardContextValue {
  register: (id: string, state: GuardState) => void;
  unregister: (id: string) => void;
  allowNextNavigation: () => void;
  requestProtectedAction: (action: () => void) => void;
}

const NavigationGuardContext = createContext<NavigationGuardContextValue | null>(null);

export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [guards, setGuards] = useState<Record<string, GuardState>>({});
  const [pendingAction, setPendingAction] = useState(false);
  const [busyNotice, setBusyNotice] = useState(false);
  const pendingActionRef = useRef<(() => void) | null>(null);
  const allowNavigation = useRef(false);
  const dirty = Object.values(guards).some((guard) => guard.dirty);
  const busy = Object.values(guards).some((guard) => guard.busy);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !allowNavigation.current &&
      (dirty || busy) &&
      `${currentLocation.pathname}${currentLocation.search}` !==
        `${nextLocation.pathname}${nextLocation.search}`,
  );

  const register = useCallback((id: string, state: GuardState) => {
    setGuards((current) => ({ ...current, [id]: state }));
  }, []);
  const unregister = useCallback((id: string) => {
    setGuards((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);
  const allowNextNavigation = useCallback(() => {
    allowNavigation.current = true;
  }, []);
  const requestProtectedAction = useCallback(
    (action: () => void) => {
      if (busy) {
        setBusyNotice(true);
        return;
      }
      if (dirty) {
        pendingActionRef.current = action;
        setPendingAction(true);
        return;
      }
      action();
    },
    [busy, dirty],
  );

  useEffect(() => {
    if (dirty || busy) allowNavigation.current = false;
  }, [busy, dirty]);

  useEffect(() => {
    if (!busy) setBusyNotice(false);
  }, [busy]);

  useEffect(() => {
    if (blocker.state === "blocked" && busy) {
      blocker.reset();
      setBusyNotice(true);
    }
  }, [blocker, busy]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const protectUnload = (event: BeforeUnloadEvent) => {
      if (!dirty && !busy) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectUnload);
    return () => window.removeEventListener("beforeunload", protectUnload);
  }, [busy, dirty]);

  const value = useMemo(
    () => ({ register, unregister, allowNextNavigation, requestProtectedAction }),
    [allowNextNavigation, register, requestProtectedAction, unregister],
  );
  const confirmOpen = pendingAction || (blocker.state === "blocked" && dirty && !busy);

  const cancelDiscard = () => {
    pendingActionRef.current = null;
    setPendingAction(false);
    if (blocker.state === "blocked") blocker.reset();
  };

  const confirmDiscard = () => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    setPendingAction(false);
    allowNavigation.current = true;
    if (blocker.state === "blocked") blocker.proceed();
    action?.();
  };

  return (
    <NavigationGuardContext.Provider value={value}>
      {children}
      {busyNotice ? (
        <div className="navigation-busy-notice" role="status">
          <Alert tone="warn">{t("navigationGuard.busy")}</Alert>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmOpen}
        title={t("navigationGuard.title")}
        description={t("navigationGuard.body")}
        confirmLabel={t("navigationGuard.discard")}
        cancelLabel={t("navigationGuard.continue")}
        tone="destructive"
        onCancel={cancelDiscard}
        onConfirm={confirmDiscard}
      />
    </NavigationGuardContext.Provider>
  );
}

export function useNavigationGuard(dirty: boolean, busy: boolean) {
  const guard = useContext(NavigationGuardContext);
  if (!guard) throw new Error("useNavigationGuard requires NavigationGuardProvider");
  const id = useId();

  useEffect(() => {
    guard.register(id, { dirty, busy });
  }, [busy, dirty, guard, id]);

  useEffect(() => () => guard.unregister(id), [guard, id]);

  return {
    allowNextNavigation: guard.allowNextNavigation,
    requestProtectedAction: guard.requestProtectedAction,
  };
}
