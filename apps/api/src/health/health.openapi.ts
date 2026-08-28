import type { SchemaObject } from "@nestjs/swagger";

/** Wire shape of `ReadinessService.live()` (see readiness.service.ts, `LiveReport`). */
export const liveReportOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", enum: ["ok"] } },
};

const componentReportOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "checkedAt"],
  properties: {
    status: { type: "string", enum: ["healthy", "degraded", "unavailable"] },
    checkedAt: { type: "string", format: "date-time" },
    category: {
      type: "string",
      enum: [
        "database_unavailable",
        "database_timeout",
        "jobs_unavailable",
        "jobs_timeout",
        "smtp_unavailable",
        "smtp_timeout",
        "storage_unavailable",
        "storage_timeout",
      ],
    },
  },
};

/** Wire shape of `ReadinessService.ready()` (see readiness.service.ts, `ReadinessReport`). */
export const readinessReportOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["status", "checkedAt", "checks"],
  properties: {
    status: { type: "string", enum: ["ok", "degraded", "unavailable"] },
    checkedAt: { type: "string", format: "date-time" },
    checks: {
      type: "object",
      additionalProperties: false,
      required: ["database", "jobs", "smtp", "storage"],
      properties: {
        database: componentReportOpenApiSchema,
        jobs: componentReportOpenApiSchema,
        smtp: componentReportOpenApiSchema,
        storage: componentReportOpenApiSchema,
      },
    },
  },
};
