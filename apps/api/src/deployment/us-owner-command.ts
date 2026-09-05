import { loadUsDevelopmentEnv } from "./entry-policy";
import { validateUsOwnerPassword } from "./us-development-owner";

export function ownerCommandEnvironment(args: readonly string[], raw: NodeJS.ProcessEnv) {
  if (args.length !== 1 || args[0] !== "--confirm-local-synthetic-owner") {
    throw new Error("us_owner_confirmation_required");
  }
  try {
    const env = loadUsDevelopmentEnv(raw);
    if (new URL(env.DATABASE_URL).username !== "markiro_us") throw new Error("wrong owner");
    return env;
  } catch {
    throw new Error("us_owner_environment_invalid");
  }
}

/** Bounded stdin only: passwords never appear in argv, output or environment. */
export async function readOwnerPassword(input: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.byteLength;
    if (size > 512) throw new Error("us_development_password_invalid");
    chunks.push(chunk);
  }
  return validateUsOwnerPassword(
    Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, ""),
  );
}
