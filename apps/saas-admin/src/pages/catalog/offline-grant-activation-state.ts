export interface GrantActivationAttempt<TRequest, TResponse> {
  request: TRequest;
  response: TResponse | null;
  notice: "uncertain" | "stale" | null;
}

export const activationKeys = {
  list: ["platform", "offline-grants", "activations"] as const,
  prepare: ["platform", "offline-grants", "activations", "prepare-attempt"] as const,
  confirm: (id: string) =>
    ["platform", "offline-grants", "activations", id, "confirm-attempt"] as const,
  cancel: (id: string) =>
    ["platform", "offline-grants", "activations", id, "cancel-attempt"] as const,
};
