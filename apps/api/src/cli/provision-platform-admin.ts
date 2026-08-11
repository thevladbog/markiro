import { createDb } from "@markiro/db";
import { z } from "zod";
import { loadEnv } from "../env";
import { MailCryptoService } from "../modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../modules/mail/mail-delivery.service";
import { PlatformActivationService } from "../platform-auth/platform-activation.service";
import { PlatformAuditService } from "../platform-auth/platform-audit.service";

const inputSchema = z.object({
  email: z
    .string()
    .transform((value) => value.trim().toLocaleLowerCase("en-US"))
    .pipe(z.email()),
});

export type ProvisionPlatformAdminInput = z.infer<typeof inputSchema>;

export function parseProvisionPlatformAdminArgs(argv: string[]): ProvisionPlatformAdminInput {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.some((argument) => argument === "--password" || argument.startsWith("--password="))) {
    throw new Error("Password arguments are forbidden; the administrator sets it through email");
  }
  if (args.length !== 2 || args[0] !== "--email" || !args[1] || args[1].startsWith("--")) {
    throw new Error("Expected exactly --email <address>");
  }
  return inputSchema.parse({ email: args[1] });
}

interface CliStream {
  write(value: string): unknown;
}

export async function runProvisionPlatformAdminCli(options: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: CliStream;
  stderr?: CliStream;
}): Promise<number> {
  try {
    const input = parseProvisionPlatformAdminArgs(options.argv);
    const env = loadEnv(options.env);
    const connection = createDb(env.DATABASE_URL);
    try {
      const activation = new PlatformActivationService(
        connection.db,
        new MailDeliveryService(new MailCryptoService(env.MAIL_PAYLOAD_ENCRYPTION_KEY)),
        new PlatformAuditService(),
        env.SAAS_ADMIN_ORIGIN,
      );
      const result = await activation.invite({
        actorPlatformUserId: null,
        actorRole: null,
        email: input.email,
        role: "platform_admin",
        idempotent: true,
        auditAction: "platform.admin.provisioned",
      });
      (options.stdout ?? process.stdout).write(`${JSON.stringify(result)}\n`);
    } finally {
      await connection.pool.end();
    }
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Platform admin provisioning failed";
    (options.stderr ?? process.stderr).write(`${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  void runProvisionPlatformAdminCli({ argv: process.argv.slice(2) }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
