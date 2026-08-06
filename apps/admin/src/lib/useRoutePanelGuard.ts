import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useBlocker } from "react-router";

export interface RoutePanelGuard {
  setDirty: Dispatch<SetStateAction<boolean>>;
  requestClose: () => void;
  confirmOpen: boolean;
  cancelDiscard: () => void;
  confirmDiscard: () => void;
  finish: () => void;
}

export function useRoutePanelGuard(close: () => void, busy: boolean): RoutePanelGuard {
  const [dirty, setDirty] = useState(false);
  const [pendingDismiss, setPendingDismiss] = useState(false);
  const allowNavigationRef = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !allowNavigationRef.current &&
      (dirty || busy) &&
      currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (busy || !dirty) blocker.reset();
    else setPendingDismiss(true);
  }, [blocker, busy, dirty]);

  const requestClose = () => {
    if (busy) return;
    if (dirty) setPendingDismiss(true);
    else close();
  };

  const cancelDiscard = () => {
    setPendingDismiss(false);
    if (blocker.state === "blocked") blocker.reset();
  };

  const confirmDiscard = () => {
    allowNavigationRef.current = true;
    setDirty(false);
    setPendingDismiss(false);
    if (blocker.state === "blocked") blocker.proceed();
    else close();
  };

  const finish = () => {
    allowNavigationRef.current = true;
    setDirty(false);
    close();
  };

  return {
    setDirty,
    requestClose,
    confirmOpen: dirty && pendingDismiss,
    cancelDiscard,
    confirmDiscard,
    finish,
  };
}
