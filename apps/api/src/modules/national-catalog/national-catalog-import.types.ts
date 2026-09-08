import type { Db, schema } from "@markiro/db";
import type { CatalogEnvironment } from "@markiro/platform-contracts";

export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type ImportActor = { tenantId: string; userId: string };
/** Server-derived environment and tenant, also usable by trusted periodic jobs. */
export type CatalogRequestContext = { tenantId: string; environment: CatalogEnvironment };
export type ImportContext = CatalogRequestContext & ImportActor;
export type { ImportItemsQuery } from "@markiro/platform-contracts";
export type LinkChange = { expectedRevision: number; action: "remove" };

export type ImportSessionRow = typeof schema.nationalCatalogImportSessions.$inferSelect;
export type ImportItemRow = typeof schema.nationalCatalogImportItems.$inferSelect;
export type ImportItemWrite = Omit<
  typeof schema.nationalCatalogImportItems.$inferInsert,
  "tenantId" | "sessionId"
>;
export type CatalogWork =
  | { kind: "list"; from: number; to: number; offset: number; hashes: string[] }
  | { kind: "gtins"; gtins: string[] };
/** Versioned internal repair/job contract. Attempts count admitted requests, not deliveries. */
export type ImportCheckpoint = {
  version: 1;
  stepId: string;
  runId: string | null;
  phase: "primary" | "catch_up" | "done";
  work: CatalogWork[];
  failures: Array<{ work: CatalogWork; reason: string; retryable: boolean }>;
  attempts: number;
  state: "pending" | "started" | "deferred" | "blocked" | "failed" | "done";
  nextRetryAt: string | null;
  enqueuePending: boolean;
};
export type ImportFeatures = { ownCatalog: boolean; gtinLookup: boolean };
