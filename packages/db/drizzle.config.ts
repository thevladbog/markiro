import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  // codes/scan_events are hand-migrated partitioned tables — excluded from
  // generate; see src/schema/codes.ts
  schema: [
    "./src/schema/auth.ts",
    "./src/schema/platform.ts",
    "./src/schema/org-profile.ts",
    "./src/schema/labels.ts",
    "./src/schema/pickup.ts",
    "./src/schema/integrations.ts",
    "./src/schema/media.ts",
    "./src/schema/mail.ts",
    "./src/schema/team.ts",
    "./src/schema/platform-auth.ts",
    "./src/schema/saas.ts",
    "./src/schema/billing.ts",
    "./src/schema/shift-exports.ts",
    "./src/schema/disaggregation.ts",
  ],
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
