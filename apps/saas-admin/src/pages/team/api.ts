import { platformApiFetch } from "../../api/client.js";

export type PlatformRole = "platform_admin" | "support" | "accountant";
export type PlatformUser = {
  id: string;
  name: string | null;
  email: string;
  role: PlatformRole;
  status: "active" | "suspended" | "pending_activation";
  twoFactorReady: boolean;
  createdAt: string;
};

export const listPlatformTeam = () => platformApiFetch<PlatformUser[]>("/team");
export const invitePlatformUser = (email: string, role: PlatformRole) =>
  platformApiFetch<{ deliveryId?: string }>("/team", {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
export const changePlatformRole = (id: string, role: PlatformRole) =>
  platformApiFetch(`/team/${id}/role`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
export const suspendPlatformUser = (id: string) =>
  platformApiFetch(`/team/${id}/suspend`, { method: "POST", body: "{}" });
export const renewPlatformActivation = (id: string) =>
  platformApiFetch(`/team/${id}/activation/renew`, { method: "POST", body: "{}" });
export const recoverPlatformTwoFactor = (id: string) =>
  platformApiFetch(`/team/${id}/2fa/recover`, { method: "POST", body: "{}" });
