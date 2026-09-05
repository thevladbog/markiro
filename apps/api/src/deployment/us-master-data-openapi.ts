import type { SchemaObject } from "@nestjs/swagger";
import { httpErrorSchema } from "../lib/openapi";

export const usMasterDataErrorSchema: SchemaObject = {
  oneOf: [
    httpErrorSchema,
    { type: "object", required: ["code"], properties: { code: { type: "string" } } },
  ],
};

const masterDataValidationErrorSchema: SchemaObject = {
  type: "object",
  required: ["code", "issues"],
  additionalProperties: false,
  properties: {
    code: { type: "string", enum: ["invalid_master_data"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "message"],
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  },
};

export const usMasterDataBadRequestSchema: SchemaObject = {
  oneOf: [
    httpErrorSchema,
    masterDataValidationErrorSchema,
    {
      type: "object",
      required: ["code"],
      additionalProperties: false,
      properties: { code: { type: "string", enum: ["us_invalid_body"] } },
    },
  ],
};
