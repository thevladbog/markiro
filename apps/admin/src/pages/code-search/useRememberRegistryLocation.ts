import { useEffect } from "react";
import { useLocation } from "react-router";

import { rememberRegistryLocation, type RegistryTab } from "./registry-location.js";

/**
 * Keeps the section's memory (`registry-location.ts`) in step with the URL of
 * the registry page that mounts it, so a later tab switch or a card's back
 * link returns to this tab with exactly these filters.
 */
export function useRememberRegistryLocation(tab: RegistryTab): void {
  const { search } = useLocation();
  useEffect(() => {
    rememberRegistryLocation(tab, search);
  }, [tab, search]);
}
