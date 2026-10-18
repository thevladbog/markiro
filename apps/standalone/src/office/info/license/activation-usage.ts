import type { StandaloneActivationRequest } from "@markiro/domain";
import type { HostApi } from "../../../host/api.js";
import type { AboutApi } from "../about-api.js";
import { loadAboutData } from "../about-data.js";
import { BUILT_IN_SUPPORT_KEYS, activeSupportKey, type SupportKeyset } from "../support-keys.js";
import { createUsageToken } from "../support-usage.js";

/** Statistics never prevent exporting an activation request; no plaintext fallback. */
export async function activationWithUsage(
  request: StandaloneActivationRequest,
  api: HostApi,
  token: string,
  about: AboutApi,
  keyset: SupportKeyset = BUILT_IN_SUPPORT_KEYS,
): Promise<StandaloneActivationRequest & { supportToken?: string }> {
  if (activeSupportKey(keyset) === null) return request;
  try {
    const [stats, license, fresh] = await Promise.all([
      api.getUsageStats(token),
      api.getLicense(token).catch(() => null),
      loadAboutData(about),
    ]);
    const supportToken = await createUsageToken(
      stats,
      {
        generatedAt: new Date(),
        appVersion: fresh.appVersion,
        hostVersion: request.hostVersion,
        hostId: request.hostId,
        role: fresh.role,
        os: fresh.system?.os ?? null,
        arch: fresh.system?.arch ?? null,
        webview: fresh.system?.webview ?? null,
        license,
      },
      keyset,
    );
    return supportToken === null ? request : { ...request, supportToken };
  } catch {
    return request;
  }
}
