import type { Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { UsDevelopmentOwnerStore } from "../../../deployment/us-development-owner.js";
import { authorizeUsMasterDataDetails } from "../master-data/us-master-data-support.js";
import type { UsDemoJournalContext } from "./us-demo-journal-contract.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Shared original-owner guard. Callers own target identity, transaction and denial namespace. */
export async function assertUsDemoTarget(
  tx: Transaction,
  db: Db,
  context: UsDemoJournalContext,
  onDenied: () => never,
): Promise<void> {
  // Native proof owns both the original predicates and the provenance lock order.
  if (
    !(await new UsDevelopmentOwnerStore(db).verifyLockedTrustedSeed(
      context.tenantId,
      context.actorUserId,
      new Date(),
      tx,
    ))
  )
    return onDenied();
  let profile: Awaited<ReturnType<typeof authorizeUsMasterDataDetails>>;
  try {
    profile = await authorizeUsMasterDataDetails(
      tx,
      context.tenantId,
      context.actorUserId,
      US_CAPABILITY.QA_MANAGE,
    );
  } catch (error) {
    // Denial/invalid configuration is private-safe; driver failures still propagate.
    if (error instanceof ForbiddenException || error instanceof ServiceUnavailableException)
      return onDenied();
    throw error;
  }
  if (profile.code !== "US_FSMA204_PROCESSOR" || profile.timeZone !== "America/Los_Angeles")
    return onDenied();
}
