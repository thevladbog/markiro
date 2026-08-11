import { createDb, type Db } from "@markiro/db";
import { loadEnv } from "../env";
import { MailCryptoService } from "../modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../modules/mail/mail-delivery.service";
import {
  TenantProvisioningService,
  type TenantProvisioningOptions,
  type TenantProvisioningResult,
} from "../modules/platform-tenants/tenant-provisioning.service";
import { provisionTenantSchema, type ProvisionTenantDto } from "../modules/platform-tenants/dto";
import { PlatformAuditService } from "../platform-auth/platform-audit.service";

export type ProvisionTenantOwnerInput = ProvisionTenantDto;
export type ProvisionTenantOwnerResult = TenantProvisioningResult;

interface ProvisionTenantOwnerOptions extends TenantProvisioningOptions {
  db: Db;
  mail: MailDeliveryService;
  adminOrigin: string;
  input: ProvisionTenantOwnerInput;
}

/**
 * Compatibility function retained for existing callers. All behavior lives
 * in TenantProvisioningService so the CLI and platform API cannot diverge.
 */
export async function provisionTenantOwner(
  options: ProvisionTenantOwnerOptions,
): Promise<ProvisionTenantOwnerResult> {
  const service = new TenantProvisioningService(
    options.db,
    options.mail,
    new PlatformAuditService(),
    options.adminOrigin,
  );
  try {
    return await service.provision(options.input, {
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.allowUnmanagedWithoutDemo === true ? { allowUnmanagedWithoutDemo: true } : {}),
      ...(options.renewActivation === true ? { renewActivation: true } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.createId ? { createId: options.createId } : {}),
      ...(options.createToken ? { createToken: options.createToken } : {}),
    });
  } catch (error) {
    if (exceptionCode(error) === "activation_delivery_sending") {
      throw new Error("Activation delivery is currently sending; retry after it settles", {
        cause: error,
      });
    }
    throw error;
  }
}

export function parseProvisionTenantOwnerArgs(argv: string[]): ProvisionTenantOwnerInput {
  const { args } = normalizeCliArgs(argv);
  if (args.some((argument) => argument === "--password" || argument.startsWith("--password="))) {
    throw new Error("Password arguments are forbidden; the owner sets it through email");
  }
  const values: Record<string, string> = {};
  const allowed = new Set(["--email", "--tenant-name", "--tenant-slug"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !allowed.has(flag)) throw new Error("Unknown or malformed argument");
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (values[flag] !== undefined) throw new Error(`Duplicate argument: ${flag}`);
    values[flag] = value;
  }
  return provisionTenantSchema.parse({
    email: values["--email"],
    tenantName: values["--tenant-name"],
    tenantSlug: values["--tenant-slug"],
  });
}

function normalizeCliArgs(argv: string[]): {
  args: string[];
  renewActivation: boolean;
  allowUnmanagedWithoutDemo: boolean;
} {
  const withoutSeparator = argv[0] === "--" ? argv.slice(1) : argv;
  let renewActivation = false;
  let allowUnmanagedWithoutDemo = false;
  const args: string[] = [];
  for (const argument of withoutSeparator) {
    if (argument === "--renew-activation") {
      if (renewActivation) throw new Error("Duplicate argument: --renew-activation");
      renewActivation = true;
      continue;
    }
    if (argument === "--allow-unmanaged-without-demo") {
      if (allowUnmanagedWithoutDemo) {
        throw new Error("Duplicate argument: --allow-unmanaged-without-demo");
      }
      allowUnmanagedWithoutDemo = true;
      continue;
    }
    args.push(argument);
  }
  return { args, renewActivation, allowUnmanagedWithoutDemo };
}

interface CliStream {
  write(value: string): unknown;
}

export async function runProvisionTenantOwnerCli(options: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: CliStream;
  stderr?: CliStream;
}): Promise<number> {
  try {
    const input = parseProvisionTenantOwnerArgs(options.argv);
    const { renewActivation, allowUnmanagedWithoutDemo } = normalizeCliArgs(options.argv);
    const env = loadEnv(options.env);
    const { db, pool } = createDb(env.DATABASE_URL);
    try {
      const result = await provisionTenantOwner({
        db,
        mail: new MailDeliveryService(new MailCryptoService(env.MAIL_PAYLOAD_ENCRYPTION_KEY)),
        adminOrigin: env.ADMIN_ORIGIN,
        input,
        renewActivation,
        allowUnmanagedWithoutDemo,
      });
      (options.stdout ?? process.stdout).write(`${JSON.stringify(result)}\n`);
    } finally {
      await pool.end();
    }
    return 0;
  } catch (error: unknown) {
    (options.stderr ?? process.stderr).write(`${safeErrorMessage(error)}\n`);
    return 1;
  }
}

function safeErrorMessage(error: unknown): string {
  const code = exceptionCode(error);
  if (code) return code;
  return error instanceof Error ? error.message : "Tenant owner provisioning failed";
}

function exceptionCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const response =
    "getResponse" in error && typeof error.getResponse === "function"
      ? (error.getResponse as () => unknown)()
      : "response" in error
        ? error.response
        : undefined;
  return response && typeof response === "object" && "code" in response
    ? String(response.code)
    : undefined;
}

if (require.main === module) {
  void runProvisionTenantOwnerCli({ argv: process.argv.slice(2) }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
