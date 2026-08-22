import {
  platformTeamContracts,
  type PlatformRole,
  type PlatformTeamUser,
} from "@markiro/platform-contracts";
import { platformApiFetch } from "../../api/client.js";

export type { PlatformRole } from "@markiro/platform-contracts";
export type PlatformUser = PlatformTeamUser;

export const listPlatformTeam = () =>
  platformApiFetch("/team", platformTeamContracts.list.response);
export const invitePlatformUser = (email: string, role: PlatformRole) =>
  platformApiFetch("/team", platformTeamContracts.invite.response, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
export const changePlatformRole = (id: string, role: PlatformRole) =>
  platformApiFetch(`/team/${id}/role`, platformTeamContracts.changeRole.response, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
export const suspendPlatformUser = (id: string) =>
  platformApiFetch(`/team/${id}/suspend`, platformTeamContracts.suspend.response, {
    method: "POST",
    body: "{}",
  });
export const renewPlatformActivation = (id: string) =>
  platformApiFetch(`/team/${id}/activation/renew`, platformTeamContracts.renewActivation.response, {
    method: "POST",
    body: "{}",
  });
export const recoverPlatformTwoFactor = (id: string) =>
  platformApiFetch(`/team/${id}/2fa/recover`, platformTeamContracts.recoverTwoFactor.response, {
    method: "POST",
    body: "{}",
  });
