import { createContext, useContext, type ReactNode } from "react";

import { createTauriUpdateShell, type UpdateShell } from "./update-shell.js";

/** The shell's update commands; a test passes its own through `UpdateShellProvider`. */
export const TAURI_UPDATE_SHELL: UpdateShell = createTauriUpdateShell();

const UpdateShellContext = createContext<UpdateShell>(TAURI_UPDATE_SHELL);

export function UpdateShellProvider({
  value,
  children,
}: {
  value: UpdateShell;
  children: ReactNode;
}) {
  return <UpdateShellContext value={value}>{children}</UpdateShellContext>;
}

export function useUpdateShell(): UpdateShell {
  return useContext(UpdateShellContext);
}
