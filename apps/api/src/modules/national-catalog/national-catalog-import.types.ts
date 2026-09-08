import type { Db } from "@markiro/db";
import type { CatalogEnvironment } from "@markiro/platform-contracts";

export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type ImportActor = { tenantId: string; userId: string };
/** Server-derived environment and tenant, also usable by trusted periodic jobs. */
export type CatalogRequestContext = { tenantId: string; environment: CatalogEnvironment };
export type ImportContext = CatalogRequestContext & ImportActor;
export type { ImportItemsQuery } from "@markiro/platform-contracts";
export type LinkChange = { expectedRevision: number; action: "remove" };
