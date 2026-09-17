import type { SchemaObject } from "@nestjs/swagger";
import type { LabelTemplateSpec } from "@markiro/domain";
import type { ShiftBundleDto } from "../shifts/dto";

export interface StationPalletBootstrapDto {
  generatedAt: string;
  products: {
    id: string;
    gtin14: string;
    name: string;
    printName: string | null;
    shelfLifeDays: number | null;
    palletBoxCapacity: number | null;
    chzProductGroupCode: number | null;
  }[];
  operators: { employeeId: string; canBuildPallets: boolean }[];
  palletSscc: ShiftBundleDto["palletSscc"];
  palletSsccRevokedFrom: number[];
  palletLabelTemplates: {
    organisation: LabelTemplateSpec | null;
    byCategory: { chzProductGroupCode: number; template: LabelTemplateSpec }[];
  };
}

export const stationPalletBootstrapOpenApiSchema: SchemaObject = {
  type: "object",
  required: [
    "generatedAt",
    "products",
    "operators",
    "palletSscc",
    "palletSsccRevokedFrom",
    "palletLabelTemplates",
  ],
  properties: {
    generatedAt: { type: "string", format: "date-time" },
    products: {
      type: "array",
      items: {
        type: "object",
        required: [
          "id",
          "gtin14",
          "name",
          "printName",
          "shelfLifeDays",
          "palletBoxCapacity",
          "chzProductGroupCode",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          gtin14: { type: "string" },
          name: { type: "string" },
          printName: { type: "string", nullable: true },
          shelfLifeDays: { type: "integer", nullable: true },
          palletBoxCapacity: { type: "integer", nullable: true },
          chzProductGroupCode: { type: "integer", nullable: true },
        },
      },
    },
    operators: {
      type: "array",
      items: {
        type: "object",
        required: ["employeeId", "canBuildPallets"],
        properties: {
          employeeId: { type: "string", format: "uuid" },
          canBuildPallets: { type: "boolean" },
        },
      },
    },
    palletSscc: {
      type: "object",
      nullable: true,
      required: [
        "issuerPrefix",
        "extensionDigit",
        "fromSerial",
        "toSerial",
        "consumedThroughSerial",
      ],
      properties: {
        issuerPrefix: { type: "string" },
        extensionDigit: { type: "integer", enum: [1] },
        fromSerial: { type: "integer" },
        toSerial: { type: "integer" },
        consumedThroughSerial: { type: "integer", nullable: true },
      },
    },
    palletSsccRevokedFrom: { type: "array", items: { type: "integer" } },
    palletLabelTemplates: {
      type: "object",
      required: ["organisation", "byCategory"],
      properties: {
        organisation: { type: "object", nullable: true, additionalProperties: true },
        byCategory: {
          type: "array",
          items: {
            type: "object",
            required: ["chzProductGroupCode", "template"],
            properties: {
              chzProductGroupCode: { type: "integer" },
              template: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
  },
};
