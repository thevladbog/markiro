import {
  platformOperationsContracts,
  type OperationsOverview,
  type PlatformHealth,
} from "@markiro/platform-contracts";

import { platformApiFetch } from "../../api/client.js";

export type { OperationsOverview, PlatformHealth };

export function getOperationsOverview() {
  return platformApiFetch("/operations/overview", {
    responseSchema: platformOperationsContracts.overview.response,
  });
}

export function getPlatformMonitoring() {
  return platformApiFetch("/operations/monitoring", {
    responseSchema: platformOperationsContracts.monitoring.response,
  });
}
