import { z } from "zod";

import builtIn from "../../../proto/fixtures/support-keys.json";

/**
 * The public keys the usage statistics of the support text are encrypted for
 * (`proto/fixtures/support-keys.json`, public halves only, in the shape of
 * `trust-keys.json`). A key is a P-256 ECDH key as a JWK with its `kid`; the
 * schema refuses a private key (`d`), another curve and an unknown field, so a
 * private key pasted into the file by mistake cannot load. A build without
 * an active public key says the statistics are not available instead of
 * printing them readable.
 */
const supportKeySchema = z
  .object({
    kid: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    jwk: z
      .object({
        kty: z.literal("EC"),
        crv: z.literal("P-256"),
        x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      })
      .strict(),
  })
  .strict();

export const supportKeysetSchema = z
  .object({
    keys: z.array(supportKeySchema),
    retiredKids: z.array(z.string()),
  })
  .strict()
  .superRefine((keyset, context) => {
    const kids = keyset.keys.map((key) => key.kid);
    if (new Set(kids).size !== kids.length) {
      context.addIssue({ code: "custom", message: "a kid is used twice", path: ["keys"] });
    }
  });
export type SupportKey = z.infer<typeof supportKeySchema>;
export type SupportKeyset = z.infer<typeof supportKeysetSchema>;

/** The keyset this build carries; a file that does not parse is an empty keyset (no statistics). */
export function parseSupportKeyset(value: unknown): SupportKeyset {
  const parsed = supportKeysetSchema.safeParse(value);
  return parsed.success ? parsed.data : { keys: [], retiredKids: [] };
}

export const BUILT_IN_SUPPORT_KEYS: SupportKeyset = parseSupportKeyset(builtIn);

/** The key the statistics are encrypted for: the newest one that is not retired, or `null`. */
export function activeSupportKey(keyset: SupportKeyset): SupportKey | null {
  const live = keyset.keys.filter((key) => !keyset.retiredKids.includes(key.kid));
  return live.at(-1) ?? null;
}
