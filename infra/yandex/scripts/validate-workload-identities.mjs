import process from "node:process";

const REQUIRED_NAMES = Object.freeze(["app", "audit", "controller", "terraform"]);

function invalid() {
  throw new Error("workload service-account IDs are invalid");
}

export function validateWorkloadIdentityIds(identities) {
  if (!identities || typeof identities !== "object") invalid();
  const names = Object.keys(identities).sort();
  if (
    names.length !== REQUIRED_NAMES.length ||
    names.some((name, index) => name !== REQUIRED_NAMES[index])
  )
    invalid();
  const values = REQUIRED_NAMES.map((name) => identities[name]);
  if (!values.every((value) => typeof value === "string" && value.trim().length > 0)) invalid();
  if (new Set(values).size !== values.length) invalid();
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  validateWorkloadIdentityIds({
    app: process.env.TF_VAR_app_service_account_id,
    audit: process.env.TF_VAR_audit_service_account_id,
    controller: process.env.TF_VAR_deployment_controller_service_account_id,
    terraform: process.env.YC_TERRAFORM_SERVICE_ACCOUNT_ID,
  });
}
