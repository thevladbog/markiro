import { z } from "zod";

import type { HostClient } from "./client.js";
import {
  bootstrapResponseSchema,
  officeSessionSchema,
  type BootstrapRequest,
  type BootstrapResponse,
  type OfficeLoginRequest,
  type OfficeSession,
} from "./protocol.js";

/** Host endpoints the shell uses; office screens add their own (plan 1b3). */
export interface HostApi {
  bootstrap(request: BootstrapRequest): Promise<BootstrapResponse>;
  officeLogin(request: OfficeLoginRequest): Promise<OfficeSession>;
  officeLogout(token: string): Promise<void>;
}

export function createHostApi(client: HostClient): HostApi {
  return {
    bootstrap: (request) =>
      client.request("POST", "/v1/bootstrap", { body: request, schema: bootstrapResponseSchema }),
    officeLogin: (request) =>
      client.request("POST", "/v1/office/login", { body: request, schema: officeSessionSchema }),
    officeLogout: async (token) => {
      await client.request("POST", "/v1/office/logout", {
        officeToken: token,
        schema: z.null(),
      });
    },
  };
}
