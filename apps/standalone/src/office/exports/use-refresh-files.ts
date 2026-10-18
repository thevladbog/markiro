import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { officeKeys } from "../office-query.js";

/**
 * Reads the lists of stored files again (the shift's «Выгрузки» and forms, a
 * card's «Сохранённые файлы»): called once a dialog has handed a file to the
 * host, so a list left open under it shows the new file.
 */
export function useRefreshStoredFiles(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: officeKeys.exportFiles });
    void queryClient.invalidateQueries({ queryKey: ["office", "shift-exports"] });
  }, [queryClient]);
}
