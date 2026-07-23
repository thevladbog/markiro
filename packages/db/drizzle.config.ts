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
  ],
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
