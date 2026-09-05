import { boolean, index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { session, user } from "./auth.js";

/** Loaded only by the independent US tenant auth factory. */
export const usTwoFactors = pgTable(
  "us_two_factors",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull().default(false),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [unique("us_two_factors_user_id_uq").on(table.userId)],
);

/** A user's MFA enrollment is not proof that every existing session passed MFA. */
export const usSessionAssurances = pgTable(
  "us_session_assurances",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references(() => session.id, { onDelete: "cascade" }),
    factorId: text("factor_id")
      .notNull()
      .references(() => usTwoFactors.id, { onDelete: "cascade" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("us_session_assurances_factor_id_idx").on(table.factorId)],
);
