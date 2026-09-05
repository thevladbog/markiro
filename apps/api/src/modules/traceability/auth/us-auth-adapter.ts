import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { usAuthError } from "./us-auth-error";
import { schema, type Db } from "@markiro/db";

/** Enrollment is insert-only until a separately authorized recovery flow exists. */
export function usAuthAdapter(db: Db): ReturnType<typeof drizzleAdapter> {
  const createAdapter = drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      organization: schema.organization,
      member: schema.member,
      invitation: schema.invitation,
      twoFactor: schema.usTwoFactors,
    },
  });
  return (options) => {
    const adapter = createAdapter(options);
    return {
      ...adapter,
      // Better Auth's enable endpoint deletes an old factor before inserting.
      // Never permit that deletion: the unique user FK remains the atomic guard
      // even when two enable requests both observed no existing factor.
      deleteMany: async (input) => (input.model === "twoFactor" ? 0 : adapter.deleteMany(input)),
      delete: async (input) => {
        if (input.model === "twoFactor")
          throw usAuthError("FORBIDDEN", "Factor replacement is not available");
        return adapter.delete(input);
      },
      create: async (input) => {
        try {
          return await adapter.create(input);
        } catch (error) {
          const cause = error instanceof Error ? error.cause : undefined;
          if (
            input.model === "twoFactor" &&
            cause &&
            typeof cause === "object" &&
            "code" in cause &&
            cause.code === "23505" &&
            "constraint" in cause &&
            cause.constraint === "us_two_factors_user_id_uq"
          ) {
            throw usAuthError("CONFLICT", "Factor enrollment already started");
          }
          throw error;
        }
      },
    };
  };
}
