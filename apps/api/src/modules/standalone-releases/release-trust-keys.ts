import type { StandaloneUpdateKeyset } from "@markiro/domain";

/**
 * The release keys a standalone host trusts (`apps/standalone/proto/fixtures/trust-keys.json`,
 * `update`): the API accepts a manifest only if the hosts it is for would. A test keeps the
 * two equal, so rotating the key means changing both in one commit.
 */
export const STANDALONE_RELEASE_KEYSET: StandaloneUpdateKeyset = {
  keys: [
    {
      kid: "upd-2026-10",
      jwk: {
        kty: "EC",
        crv: "P-256",
        x: "dXQob2nZ4ybIsfeAWqK44Q0tUhdSjzAITaPdg7lp-EU",
        y: "F-xp6WIQK3CPUGJVoq9YX4lcjtJxztziGhLzUsbR-t8",
      },
    },
  ],
  retiredKids: [],
};
