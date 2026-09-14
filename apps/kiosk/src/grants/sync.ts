import type { KioskClient } from "../api/client.js";
import { isDeviceRevoked } from "../api/client.js";
import type { CreateOrderAdmissionDto, CreateOrderAdmissionResultDto } from "../api/types.js";
import { sameBoxRegistryCredentialOwner } from "../store/installation-binding.js";
import {
  beginGrantRequest,
  installGrantKeyset,
  installGrantResponse,
  installGrantConfiguration,
} from "./transport.js";
import { persistGrantReservation, readGrantReservation } from "./reservations.js";
import { kioskGrantReservationResultSchema } from "@markiro/platform-contracts";
import { flushKioskGrantReadiness, prepareKioskGrantReadiness } from "./readiness.js";
const negotiation = () => ({
  protocol: "offline-grants-v1" as const,
  capability: "offline-grants-v1" as const,
  requestId: crypto.randomUUID(),
});
/** Optional deployment: recovery and the existing bootstrap never depend on grant availability. */
export async function refreshGrants(client: KioskClient): Promise<void> {
  if (!client.grantKeyset || !client.issueDeviceGrant || !client.registryOwner) return;
  try {
    await flushKioskGrantReadiness(client);
  } catch {
    console.warn("kiosk: grant readiness unavailable");
  }
  const lease = await beginGrantRequest();
  if (!lease || !sameBoxRegistryCredentialOwner(lease.owner, client.registryOwner)) return;
  try {
    if (client.grantConfiguration) {
      await installGrantConfiguration(lease, await client.grantConfiguration(negotiation()));
    } else if (!(await installGrantKeyset(lease, await client.grantKeyset()))) return;
    const installed = await installGrantResponse(
      lease,
      await client.issueDeviceGrant(negotiation()),
    );
    if (installed) {
      await prepareKioskGrantReadiness(lease.owner);
      try {
        await flushKioskGrantReadiness(client);
      } catch {
        console.warn("kiosk: grant readiness unavailable");
      }
    }
  } catch (error) {
    if (isDeviceRevoked(error)) throw error;
    console.warn("kiosk: grant refresh unavailable");
  }
}
/** This is evidence attachment to an accepted durable order, never fresh productive admission. */
export async function negotiateReservationEvidence(
  client: KioskClient,
  body: CreateOrderAdmissionDto,
): Promise<CreateOrderAdmissionResultDto | null> {
  if (!client.reserveGrantOrder || !client.registryOwner) return null;
  const lease = await beginGrantRequest();
  if (!lease || !sameBoxRegistryCredentialOwner(lease.owner, client.registryOwner)) return null;
  let admission: CreateOrderAdmissionResultDto | null = null;
  try {
    const result = kioskGrantReservationResultSchema.parse(
      await client.reserveGrantOrder({ ...negotiation(), order: body }),
    );
    if (result.status !== "reserved") return null;
    admission = result.admission;
    if (!(await persistGrantReservation(lease, body, result))) return admission;
    const saved = await readGrantReservation(lease.owner, body.deviceSeq);
    if (saved && client.issueTaskGrant) {
      await installGrantResponse(
        lease,
        await client.issueTaskGrant({ ...negotiation(), taskKind: "pickup", taskId: saved.taskId }),
        body.deviceSeq,
      );
    }
  } catch (error) {
    if (isDeviceRevoked(error)) throw error;
    console.warn("kiosk: reservation grant evidence unavailable");
  }
  return admission;
}
