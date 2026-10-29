import type { UsRuntime } from "./us-runtime";

export type UsBusinessRuntimeView = Readonly<
  Pick<
    UsRuntime,
    | "auth"
    | "profiles"
    | "masterData"
    | "catalog"
    | "lots"
    | "productProfiles"
    | "referenceDocuments"
    | "receiving"
    | "receivingCsv"
    | "cases"
    | "transformation"
    | "shipping"
    | "events"
    | "trace"
    | "planRead"
    | "planDrafts"
    | "planInspection"
    | "planApproval"
    | "assertDatabaseReady"
    | "databaseOperation"
  >
> &
  Readonly<{
    connection: Readonly<Pick<UsRuntime["connection"], "db">>;
    requestHttp: Readonly<{
      reads: Readonly<
        Pick<UsRuntime["requestHttp"]["reads"], "list" | "listRuns" | "getRun" | "listAttempts">
      >;
      commands: Readonly<
        Pick<
          UsRuntime["requestHttp"]["commands"],
          "create" | "update" | "close" | "validate" | "acknowledgeWarnings" | "prepare" | "retry"
        >
      >;
      downloads: Readonly<Pick<UsRuntime["requestHttp"]["downloads"], "download">>;
      get: UsRuntime["requestHttp"]["get"];
    }>;
  }>;
