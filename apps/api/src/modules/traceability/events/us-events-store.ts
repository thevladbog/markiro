import type { Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { usEventListQuerySchema, type UsEventList } from "@markiro/platform-contracts";
import { authorizeUsMasterData, parseMasterDataInput } from "../master-data/us-master-data-support";
import { transformationTransaction } from "../transformation/us-transformation-operations";
import { readEventsRegistry } from "./us-events-registry";

export class UsEventsStore {
  constructor(private readonly db: Db) {}
  list(tenantId: string, actorUserId: string, query: unknown): Promise<UsEventList> {
    return transformationTransaction(this.db, async (tx) => {
      await authorizeUsMasterData(tx, tenantId, actorUserId, US_CAPABILITY.READ);
      return readEventsRegistry(tx, tenantId, parseMasterDataInput(usEventListQuerySchema, query));
    });
  }
}
