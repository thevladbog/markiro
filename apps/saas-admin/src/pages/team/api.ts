import {
  platformTeamContracts,
  type PlatformRole,
  type PlatformTeamUser,
} from "@markiro/platform-contracts";
import { platformApiFetch } from "../../api/client.js";

export type { PlatformRole } from "@markiro/platform-contracts";
export type PlatformUser = PlatformTeamUser;

export const listPlatformTeam = () =>
  platformApiFetch("/team", { responseSchema: platformTeamContracts.list.response });
export const invitePlatformUser = (email: string, role: PlatformRole) =>
  platformApiFetch("/team", {
    responseSchema: platformTeamContracts.invite.response,
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
export const changePlatformRole = (id: string, role: PlatformRole) => {
  const params = platformTeamContracts.changeRole.params.parse({ id });
  return platformApiFetch(`/team/${encodeURIComponent(params.id)}/role`, {
    responseSchema: platformTeamContracts.changeRole.response,
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
};
export const suspendPlatformUser = (id: string) => {
  const params = platformTeamContracts.suspend.params.parse({ id });
  return platformApiFetch(`/team/${encodeURIComponent(params.id)}/suspend`, {
    responseSchema: platformTeamContracts.suspend.response,
    method: "POST",
    body: "{}",
  });
};
export const renewPlatformActivation = (id: string) => {
  const params = platformTeamContracts.renewActivation.params.parse({ id });
  return platformApiFetch(`/team/${encodeURIComponent(params.id)}/activation/renew`, {
    responseSchema: platformTeamContracts.renewActivation.response,
    method: "POST",
    body: "{}",
  });
};
export const recoverPlatformTwoFactor = (id: string) => {
  const params = platformTeamContracts.recoverTwoFactor.params.parse({ id });
  return platformApiFetch(`/team/${encodeURIComponent(params.id)}/2fa/recover`, {
    responseSchema: platformTeamContracts.recoverTwoFactor.response,
    method: "POST",
    body: "{}",
  });
};
