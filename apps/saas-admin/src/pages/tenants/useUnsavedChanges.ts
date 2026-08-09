import { useEffect, useRef } from "react";
import { useBlocker } from "react-router";

export function useUnsavedChanges(dirty: boolean, busy: boolean) {
  const allowNavigation = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !allowNavigation.current &&
      (dirty || busy) &&
      currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (dirty) allowNavigation.current = false;
  }, [dirty]);

  useEffect(() => {
    if (blocker.state === "blocked" && (busy || !dirty)) blocker.reset();
  }, [blocker, busy, dirty]);

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

  return {
    confirmOpen: blocker.state === "blocked" && dirty && !busy,
    cancelDiscard: () => {
      if (blocker.state === "blocked") blocker.reset();
    },
    confirmDiscard: () => {
      allowNavigation.current = true;
      if (blocker.state === "blocked") blocker.proceed();
    },
    allowNextNavigation: () => {
      allowNavigation.current = true;
    },
  };
}
