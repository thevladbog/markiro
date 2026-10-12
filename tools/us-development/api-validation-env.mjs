/** Pure guards; this module never connects, launches, or reads operational configuration. */
export function cleanRuntimeEnv(inherited) {
  return Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"]
      .filter((key) => typeof inherited[key] === "string")
      .map((key) => [key, inherited[key]]),
  );
}

export function validateBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("API validation requires the isolated loopback administrative database");
  }
  if (
    typeof raw !== "string" ||
    raw !== url.toString() ||
    url.protocol !== "postgres:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55432" ||
    url.pathname !== "/markiro_us_dev" ||
    url.username !== "markiro_us" ||
    !url.password ||
    url.search ||
    url.hash
  )
    throw new Error("API validation requires the isolated loopback administrative database");
  return url;
}

export function createValidationEnv(base, name, secrets, inherited, services) {
  const url = validateBaseUrl(base);
  if (
    !/^markiro_us_api_[0-9a-f]{8}_[0-9a-f]{4}_4[0-9a-f]{3}_[89ab][0-9a-f]{3}_[0-9a-f]{12}$/.test(
      name,
    )
  ) {
    throw new Error("API validation requires an invocation-owned child name");
  }
  url.pathname = `/${name}`;
  if (
    !Number.isInteger(services?.port) ||
    services.port <= 1025 ||
    services.port > 65535 ||
    services.port === 9000
  ) {
    throw new Error("API validation requires an invocation-reserved service port");
  }
  // Allow only runtime discovery, never application or Node/PG configuration.
  return {
    ...cleanRuntimeEnv(inherited),
    NODE_ENV: "test",
    DATABASE_URL: url.toString(),
    BETTER_AUTH_SECRET: secrets.auth,
    BETTER_AUTH_URL: "http://localhost:3000",
    PLATFORM_AUTH_SECRET: secrets.platform,
    PLATFORM_AUTH_URL: "http://localhost:3000",
    ADMIN_ORIGIN: "http://localhost:5173",
    SAAS_ADMIN_ORIGIN: "http://localhost:5473",
    KIOSK_ORIGIN: "http://localhost:5373",
    PAIRING_CODE_PEPPER: secrets.pepper,
    CHZ_TOKEN_ENCRYPTION_KEY: secrets.chz,
    MAIL_PAYLOAD_ENCRYPTION_KEY: secrets.mail,
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(services.port),
    SMTP_SECURE: "false",
    S3_ENDPOINT: `http://127.0.0.1:${services.port}`,
  };
}

export function validationArgs(args) {
  if (args.length !== 1 || !["remaining", "full"].includes(args[0])) {
    throw new Error("Usage: node tools/us-development/run-api-validation.mjs remaining|full");
  }
  if (args[0] === "full") return ["run"];
  return [
    "run",
    ...[
      "billing-accounts.e2e",
      "exchange-credentials.e2e",
      "exchange-import.e2e",
      "exchange-orders.e2e",
      "exchange-protocol.e2e",
      "integrations-delete.e2e",
      "integrations.e2e",
      "subscription-route-inventory",
    ].map((name) => `test/${name}.test.ts`),
  ];
}
