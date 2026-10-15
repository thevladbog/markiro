import { describe, expect, it } from "vitest";
import {
  STANDALONE_DIAGNOSTICS_ERROR_CODES,
  platformStandaloneDiagnosticsContracts as contracts,
  standaloneDiagnosticsHistoryQuerySchema,
  standaloneDiagnosticsIngestRequestSchema,
  standaloneDiagnosticsStatisticsQuerySchema,
} from "../src/index.js";

describe("standalone diagnostics contracts (plan ДИАГ К1)", () => {
  it("takes the pasted text and the unbound-host acknowledgement, nothing else", () => {
    expect(standaloneDiagnosticsIngestRequestSchema.safeParse({ text: "x" }).success).toBe(true);
    expect(
      standaloneDiagnosticsIngestRequestSchema.safeParse({
        text: "x",
        acknowledgeUnboundHost: true,
      }).success,
    ).toBe(true);
    expect(standaloneDiagnosticsIngestRequestSchema.safeParse({ text: "" }).success).toBe(false);
    expect(
      standaloneDiagnosticsIngestRequestSchema.safeParse({ text: "x", tenantId: "t" }).success,
    ).toBe(false);
  });

  it("describes query strings as strings the service parses (OpenAPI 3.0 safe)", () => {
    expect(standaloneDiagnosticsHistoryQuerySchema.safeParse({ limit: "50" }).success).toBe(true);
    expect(standaloneDiagnosticsHistoryQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(standaloneDiagnosticsHistoryQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(standaloneDiagnosticsHistoryQuerySchema.safeParse({ cursor: "a b" }).success).toBe(
      false,
    );
    const q = standaloneDiagnosticsStatisticsQuerySchema;
    expect(q.safeParse({ hostKey: "unknown", from: "2026-01", to: "2026-10" }).success).toBe(true);
    expect(q.safeParse({ hostKey: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f" }).success).toBe(true);
    expect(q.safeParse({ hostKey: "host-1" }).success).toBe(false);
    expect(q.safeParse({ from: "2026-13" }).success).toBe(false);
  });

  it("publishes five routes under the tenant with the access split of the spec", () => {
    expect(Object.entries(contracts).map(([name, c]) => [name, c.method, c.path])).toEqual([
      ["ingest", "POST", "/platform/tenants/:tenantId/standalone-diagnostics"],
      ["history", "GET", "/platform/tenants/:tenantId/standalone-diagnostics"],
      ["overview", "GET", "/platform/tenants/:tenantId/standalone-diagnostics/overview"],
      ["statistics", "GET", "/platform/tenants/:tenantId/standalone-diagnostics/statistics"],
      ["detail", "GET", "/platform/tenants/:tenantId/standalone-diagnostics/:diagnosticId"],
    ]);
  });

  it("lists every refusal code the API can answer with, all prefixed", () => {
    expect([...STANDALONE_DIAGNOSTICS_ERROR_CODES].sort()).toEqual(
      [
        "standalone_diagnostics_cursor_invalid",
        "standalone_diagnostics_generated_in_future",
        "standalone_diagnostics_host_other_tenant",
        "standalone_diagnostics_host_unbound",
        "standalone_diagnostics_no_token",
        "standalone_diagnostics_not_configured",
        "standalone_diagnostics_payload_invalid",
        "standalone_diagnostics_payload_too_large",
        "standalone_diagnostics_text_too_large",
        "standalone_diagnostics_token_conflict",
        "standalone_diagnostics_token_malformed",
        "standalone_diagnostics_token_too_large",
        "standalone_diagnostics_undecryptable",
        "standalone_diagnostics_unknown_key",
      ].sort(),
    );
  });
});
