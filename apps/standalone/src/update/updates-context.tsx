import { createContext, useContext, type ReactNode } from "react";

import { createTauriUpdatesApi, type UpdatesApi } from "./updates-api.js";

/** The shell's update commands; a test passes its own through `UpdatesProvider`. */
export const TAURI_UPDATES: UpdatesApi = createTauriUpdatesApi();

const UpdatesContext = createContext<UpdatesApi>(TAURI_UPDATES);

export function UpdatesProvider({ value, children }: { value: UpdatesApi; children: ReactNode }) {
  return <UpdatesContext value={value}>{children}</UpdatesContext>;
}

export function useUpdates(): UpdatesApi {
  return useContext(UpdatesContext);
}
