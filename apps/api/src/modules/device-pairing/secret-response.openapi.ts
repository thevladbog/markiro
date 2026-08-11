import { ApiResponse, type ApiResponseOptions } from "@nestjs/swagger";

type ResponseSchema = Extract<ApiResponseOptions, { schema: object }>["schema"];

const NO_STORE_HEADERS = {
  "Cache-Control": {
    description: "One-time credential material must not be stored by clients or intermediaries.",
    schema: { type: "string", enum: ["no-store"] },
  },
};

const pairingCodeSchema: ResponseSchema = {
  type: "object",
  required: ["code", "expiresAt"],
  properties: {
    code: { type: "string", pattern: "^\\d{8}$", description: "Single-use pairing code." },
    expiresAt: { type: "string", format: "date-time" },
  },
};

const stationOperatorSchema: ResponseSchema = {
  type: "object",
  required: ["operatorId", "name", "login", "role", "pinHash", "badgeHash", "active"],
  properties: {
    operatorId: { type: "string" },
    name: { type: "string" },
    login: { type: "string" },
    role: { type: "string" },
    pinHash: { type: "string", description: "Offline verifier, not a plaintext PIN." },
    badgeHash: { type: "string", nullable: true },
    active: { type: "boolean" },
  },
};

const kioskOperatorSchema: ResponseSchema = {
  type: "object",
  required: ["employeeId", "name", "login", "role", "pinHash", "badgeHash", "active"],
  properties: {
    employeeId: { type: "string" },
    name: { type: "string" },
    login: { type: "string" },
    role: { type: "string" },
    pinHash: { type: "string", description: "Offline verifier, not a plaintext PIN." },
    badgeHash: { type: "string", nullable: true },
    active: { type: "boolean" },
  },
};

export const subscriptionAccessSchema: ResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["access", "status", "startsAt", "endsAt"],
  properties: {
    access: { type: "string", enum: ["managed", "read_only", "unmanaged"] },
    status: {
      type: "string",
      enum: ["unmanaged", "pending_activation", "trial", "active", "expired", "read_only"],
    },
    startsAt: { type: "string", format: "date-time", nullable: true },
    endsAt: { type: "string", format: "date-time", nullable: true },
  },
};

const stationPairSchema: ResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["device", "credential", "operators"],
  properties: {
    device: {
      type: "object",
      required: ["id", "name", "tenantId", "organizationName", "line"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        tenantId: { type: "string" },
        organizationName: { type: "string" },
        line: {
          type: "object",
          nullable: true,
          required: ["id", "name"],
          properties: { id: { type: "string" }, name: { type: "string" } },
        },
      },
    },
    credential: {
      type: "object",
      required: ["apiKey", "serverUrl"],
      properties: {
        apiKey: { type: "string", description: "One-time station API key reveal." },
        serverUrl: { type: "string", format: "uri" },
      },
    },
    operators: { type: "array", items: stationOperatorSchema },
    subscription: {
      ...subscriptionAccessSchema,
      description: "Present only when the client sends subscription-state-v1.",
    },
  },
};

const kioskBootstrapSchema: ResponseSchema = {
  type: "object",
  required: [
    "generatedAt",
    "subscription",
    "config",
    "badgeSalt",
    "reasons",
    "products",
    "employees",
    "operators",
  ],
  properties: {
    generatedAt: { type: "string", format: "date-time" },
    subscription: subscriptionAccessSchema,
    config: {
      type: "object",
      required: ["dayLimitPerEmployee", "showPrices"],
      properties: {
        dayLimitPerEmployee: { type: "integer", minimum: 1 },
        showPrices: { type: "boolean" },
      },
    },
    badgeSalt: { type: "string", format: "byte" },
    reasons: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "name"],
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
    products: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "gtin14", "name", "unitPrice", "egaisCode"],
        properties: {
          id: { type: "string" },
          gtin14: { type: "string" },
          name: { type: "string" },
          unitPrice: { type: "string", nullable: true },
          egaisCode: { type: "string", nullable: true },
        },
      },
    },
    employees: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "fullName", "role", "badgeHash", "takenTodayElsewhere"],
        properties: {
          id: { type: "string" },
          fullName: { type: "string" },
          role: { type: "string", nullable: true },
          badgeHash: { type: "string", nullable: true },
          takenTodayElsewhere: { type: "integer", minimum: 0 },
        },
      },
    },
    operators: { type: "array", items: kioskOperatorSchema },
  },
};

const kioskPairSchema: ResponseSchema = {
  type: "object",
  required: ["device", "token", "nextDeviceSeq", "bootstrap"],
  properties: {
    device: {
      type: "object",
      required: ["kioskId", "kioskName", "place"],
      properties: {
        kioskId: { type: "string" },
        kioskName: { type: "string" },
        place: { type: "string", nullable: true },
      },
    },
    token: { type: "string", description: "One-time kiosk device token reveal." },
    nextDeviceSeq: { type: "integer", minimum: 0 },
    bootstrap: kioskBootstrapSchema,
  },
};

const kioskEnrollSchema: ResponseSchema = {
  type: "object",
  required: ["token"],
  properties: { token: { type: "string", description: "One-time kiosk device token reveal." } },
};

function secretResponse(status: 200 | 201, description: string, schema: ResponseSchema) {
  return ApiResponse({ status, description, headers: NO_STORE_HEADERS, schema });
}

export function ApiPairingCodeSecretResponse() {
  return secretResponse(201, "A newly issued single-use pairing code.", pairingCodeSchema);
}

export function ApiStationPairSecretResponse() {
  return secretResponse(
    201,
    "Station identity, one-time credential, and offline roster.",
    stationPairSchema,
  );
}

export function ApiKioskPairSecretResponse() {
  return secretResponse(
    201,
    "Kiosk identity, one-time token, sequence ceiling, and bootstrap.",
    kioskPairSchema,
  );
}

export function ApiLegacyKioskEnrollSecretResponse() {
  return secretResponse(200, "A one-time legacy kiosk enrollment token.", kioskEnrollSchema);
}
