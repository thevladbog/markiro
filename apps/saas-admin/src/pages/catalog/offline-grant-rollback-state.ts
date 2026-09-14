export interface GrantRollbackAttempt<TRequest> {
  request: TRequest;
  notice: "uncertain" | "stale" | null;
}

export const rollbackKeys = {
  candidates: ["platform", "offline-grants", "rollbacks", "candidates"] as const,
  list: ["platform", "offline-grants", "rollbacks"] as const,
  prepare: ["platform", "offline-grants", "rollbacks", "prepare-attempt"] as const,
  confirm: (id: string) =>
    ["platform", "offline-grants", "rollbacks", id, "confirm-attempt"] as const,
  cancel: (id: string) =>
    ["platform", "offline-grants", "rollbacks", id, "cancel-attempt"] as const,
};
