import { useNavigationGuard } from "../../layout/NavigationGuard.js";

export function useUnsavedChanges(dirty: boolean, busy: boolean) {
  return useNavigationGuard(dirty, busy);
}
