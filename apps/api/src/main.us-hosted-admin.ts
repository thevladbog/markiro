import { parseUsHostedAdminOperation } from "./deployment/us-hosted-admin-config";
import {
  disposeUsHostedAdminRelease,
  verifyUsHostedAdminRelease,
} from "./deployment/us-hosted-admin-release";

async function main(): Promise<void> {
  process.exitCode = 1;
  try {
    const operation = parseUsHostedAdminOperation(process.argv.slice(2));
    const release = await verifyUsHostedAdminRelease(operation);
    // No execution producer exists yet. Dispose admitted provenance before the locked refusal.
    disposeUsHostedAdminRelease(release);
    process.stderr.write("us_hosted_provisioning_required\n");
  } catch {
    process.stderr.write("us_hosted_admin_startup_refused\n");
  }
}

void main().catch(() => {
  process.exitCode = 1;
  process.stderr.write("us_hosted_admin_startup_refused\n");
});
