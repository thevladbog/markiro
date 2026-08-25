import { readFile } from "node:fs/promises";
import process from "node:process";

const protectedAddresses = new Set([
  "module.compute.yandex_vpc_address.app",
  "module.compute.yandex_compute_instance.app",
  "module.postgres.yandex_mdb_postgresql_cluster.production",
  "module.postgres.yandex_mdb_postgresql_database.application",
  "module.object_storage.yandex_storage_bucket.media",
  "module.object_storage.yandex_storage_bucket.audit",
]);
const directVmDnsAddresses = new Set([
  "yandex_dns_recordset.application[0]",
  "yandex_dns_recordset.saas_admin_application[0]",
  "yandex_dns_recordset.kiosk_application[0]",
  "yandex_dns_recordset.landing_application[0]",
]);

const safeProductionResources = new Map([
  ["module.network.yandex_vpc_network.production", "yandex_vpc_network"],
  ["module.network.yandex_vpc_gateway.nat", "yandex_vpc_gateway"],
  ["module.network.yandex_vpc_route_table.private_egress", "yandex_vpc_route_table"],
  ["module.network.yandex_vpc_subnet.app", "yandex_vpc_subnet"],
  ["module.network.yandex_vpc_subnet.data", "yandex_vpc_subnet"],
  ["module.network.yandex_vpc_security_group.app", "yandex_vpc_security_group"],
  ["module.network.yandex_vpc_security_group.data", "yandex_vpc_security_group"],
  ["module.compute.data.yandex_compute_image.ubuntu_lts", "yandex_compute_image"],
  ["module.compute.yandex_vpc_address.app", "yandex_vpc_address"],
  ["module.compute.yandex_compute_instance.app", "yandex_compute_instance"],
  ["module.postgres.yandex_mdb_postgresql_cluster.production", "yandex_mdb_postgresql_cluster"],
  ["module.postgres.yandex_mdb_postgresql_database.application", "yandex_mdb_postgresql_database"],
  ["module.object_storage.yandex_storage_bucket.media", "yandex_storage_bucket"],
  ["module.object_storage.yandex_storage_bucket.audit", "yandex_storage_bucket"],
  ["module.object_storage.yandex_storage_bucket_policy.media_app", "yandex_storage_bucket_policy"],
  [
    "module.object_storage.yandex_storage_bucket_iam_binding.app_uploader",
    "yandex_storage_bucket_iam_binding",
  ],
  ...[...directVmDnsAddresses].map((address) => [address, "yandex_dns_recordset"]),
]);

const retiredProductionResources = new Map([
  ["yandex_logging_group.application", "yandex_logging_group"],
  ["module.network.yandex_vpc_subnet.alb", "yandex_vpc_subnet"],
  ["module.network.yandex_vpc_security_group.alb", "yandex_vpc_security_group"],
  ["module.compute.terraform_data.app_cloud_init", "terraform_data"],
  [
    "module.compute.yandex_compute_instance_iam_binding.deployment_controller_app_viewer",
    "yandex_compute_instance_iam_binding",
  ],
  ["module.compute.yandex_alb_target_group.app", "yandex_alb_target_group"],
  ["module.ingress.yandex_vpc_address.markiro", "yandex_vpc_address"],
  ["module.ingress.yandex_cm_certificate.markiro", "yandex_cm_certificate"],
  ["module.ingress.yandex_dns_recordset.certificate_validation[0]", "yandex_dns_recordset"],
  ["module.ingress.data.yandex_cm_certificate.issued", "yandex_cm_certificate"],
  ["module.ingress.yandex_cm_certificate.kiosk", "yandex_cm_certificate"],
  ["module.ingress.yandex_dns_recordset.kiosk_certificate_validation[0]", "yandex_dns_recordset"],
  ["module.ingress.data.yandex_cm_certificate.kiosk_issued", "yandex_cm_certificate"],
  ["module.ingress.yandex_alb_backend_group.app", "yandex_alb_backend_group"],
  [
    "module.ingress.yandex_sws_advanced_rate_limiter_profile.markiro",
    "yandex_sws_advanced_rate_limiter_profile",
  ],
  ["module.ingress.yandex_sws_security_profile.markiro", "yandex_sws_security_profile"],
  ["module.ingress.yandex_alb_http_router.markiro", "yandex_alb_http_router"],
  ["module.ingress.yandex_alb_virtual_host.markiro", "yandex_alb_virtual_host"],
  ["module.ingress.yandex_alb_load_balancer.markiro", "yandex_alb_load_balancer"],
  ["module.ingress.yandex_dns_recordset.application[0]", "yandex_dns_recordset"],
  ["module.ingress.yandex_dns_recordset.kiosk_application[0]", "yandex_dns_recordset"],
  ["module.observability.yandex_logging_group.security", "yandex_logging_group"],
  ["module.observability.yandex_audit_trails_trail.realtime", "yandex_audit_trails_trail"],
  ["module.observability.yandex_audit_trails_trail.archive", "yandex_audit_trails_trail"],
  ["module.observability.yandex_monitoring_dashboard.production", "yandex_monitoring_dashboard"],
]);

const releasePrefix = "module.station_releases.";
const releaseAddresses = new Set([
  "module.station_releases.yandex_storage_bucket.releases",
  "module.station_releases.yandex_storage_bucket_policy.releases",
  "module.station_releases.yandex_storage_bucket_iam_binding.publisher_uploader",
  "module.station_releases.yandex_iam_service_account.station_release_publisher",
  "module.station_releases.yandex_iam_service_account_static_access_key.publisher",
  "module.station_releases.yandex_cdn_origin_group.releases",
  "module.station_releases.yandex_cm_certificate.releases",
  "module.station_releases.yandex_dns_recordset.certificate_validation[0]",
  "module.station_releases.yandex_cdn_resource.releases",
  "module.station_releases.yandex_dns_recordset.public_release[0]",
  "module.station_releases.data.yandex_cm_certificate.issued",
]);
const releaseResourceTypes = new Map([
  ["module.station_releases.yandex_storage_bucket.releases", "yandex_storage_bucket"],
  ["module.station_releases.yandex_storage_bucket_policy.releases", "yandex_storage_bucket_policy"],
  [
    "module.station_releases.yandex_storage_bucket_iam_binding.publisher_uploader",
    "yandex_storage_bucket_iam_binding",
  ],
  [
    "module.station_releases.yandex_iam_service_account.station_release_publisher",
    "yandex_iam_service_account",
  ],
  [
    "module.station_releases.yandex_iam_service_account_static_access_key.publisher",
    "yandex_iam_service_account_static_access_key",
  ],
  ["module.station_releases.yandex_cdn_origin_group.releases", "yandex_cdn_origin_group"],
  ["module.station_releases.yandex_cm_certificate.releases", "yandex_cm_certificate"],
  [
    "module.station_releases.yandex_dns_recordset.certificate_validation[0]",
    "yandex_dns_recordset",
  ],
  ["module.station_releases.yandex_cdn_resource.releases", "yandex_cdn_resource"],
  ["module.station_releases.yandex_dns_recordset.public_release[0]", "yandex_dns_recordset"],
  ["module.station_releases.data.yandex_cm_certificate.issued", "yandex_cm_certificate"],
]);
const requiredReleaseAddresses = new Set(
  [...releaseAddresses].filter(
    (address) =>
      address !== "module.station_releases.yandex_dns_recordset.public_release[0]" &&
      address !== "module.station_releases.data.yandex_cm_certificate.issued",
  ),
);
const expectedReleaseDomain = "releases.markiro.app";
const publisherReference = [
  "yandex_iam_service_account.station_release_publisher.id",
  "yandex_iam_service_account.station_release_publisher",
];
const releaseBucketReference = [
  "yandex_storage_bucket.releases.bucket",
  "yandex_storage_bucket.releases",
];
const originGroupReference = [
  "yandex_cdn_origin_group.releases.id",
  "yandex_cdn_origin_group.releases",
];
const cdnReference = [
  "yandex_cdn_resource.releases.provider_cname",
  "yandex_cdn_resource.releases",
];

function rejected(scope) {
  throw new Error(scope ? `production plan rejected (${scope})` : "production plan rejected");
}

function scoped(scope, callback) {
  try {
    return callback();
  } catch {
    rejected(scope);
  }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function actions(resource) {
  const value = resource.change?.actions;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((action) => typeof action !== "string")
  )
    rejected();
  return value;
}

function includesDelete(resource) {
  return actions(resource).includes("delete");
}

function after(resource) {
  const value = resource.change?.after;
  if (!object(value)) rejected();
  return value;
}

function sortedStrings(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) rejected();
  return [...value].sort();
}

function exactStrings(value, expected) {
  const actual = sortedStrings(value);
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index]))
    rejected();
}

function exactKeys(value, expected) {
  if (!object(value)) rejected();
  exactStrings(Object.keys(value), expected);
}

function nonblank(value) {
  if (typeof value !== "string" || value.trim().length === 0) rejected();
  return value;
}

function computed(resource, attribute) {
  return resource.change?.after_unknown?.[attribute] === true;
}

function knownOrComputed(resource, attribute) {
  const value = resource.change?.after?.[attribute];
  if (value === null || value === undefined) {
    if (!computed(resource, attribute)) rejected();
    return null;
  }
  return value;
}

function configurationAddress(address) {
  if (typeof address !== "string") rejected();
  return address.replace(/\[(?:\d+|"(?:[^"\\]|\\.)*")\]/g, "");
}

function collectConfigurationResources(module, prefix, resources) {
  if (!object(module)) rejected();
  if (module.resources !== undefined) {
    if (!Array.isArray(module.resources)) rejected();
    for (const resource of module.resources) {
      if (!object(resource) || typeof resource.address !== "string") rejected();
      const address = prefix ? `${prefix}.${resource.address}` : resource.address;
      const normalized = configurationAddress(address);
      if (resources.has(normalized)) rejected();
      resources.set(normalized, resource);
    }
  }
  if (module.module_calls !== undefined) {
    if (!object(module.module_calls)) rejected();
    for (const [name, call] of Object.entries(module.module_calls)) {
      if (!/^[A-Za-z0-9_-]+$/.test(name) || !object(call) || !object(call.module)) rejected();
      const childPrefix = prefix ? `${prefix}.module.${name}` : `module.${name}`;
      collectConfigurationResources(call.module, childPrefix, resources);
    }
  }
}

function proveExactReferences(plan, resource, attribute, expected) {
  const resources = new Map();
  collectConfigurationResources(plan.configuration?.root_module, "", resources);
  const configuration = resources.get(configurationAddress(resource.address));
  if (!object(configuration) || !object(configuration.expressions)) rejected();
  const expression = configuration.expressions[attribute];
  exactKeys(expression, ["references"]);
  exactStrings(expression.references, expected);
}

function knownOrReferenced(plan, resource, attribute, expectedReferences) {
  const value = resource.change?.after?.[attribute];
  if (value === null || value === undefined) {
    if (!computed(resource, attribute)) rejected();
    proveExactReferences(plan, resource, attribute, expectedReferences);
    return null;
  }
  return value;
}

function onlyCreate(resource) {
  const value = actions(resource);
  return value.length === 1 && value[0] === "create";
}

function onlyAllowedAction(resourceActions, allowed) {
  return resourceActions.length === 1 && allowed.includes(resourceActions[0]);
}

function canonicalUser(statement) {
  exactKeys(statement.Principal, ["CanonicalUser"]);
  return nonblank(statement.Principal.CanonicalUser);
}

function statement(policy, sid, keys) {
  const matches = policy.Statement.filter((candidate) => candidate?.Sid === sid);
  if (matches.length !== 1) rejected();
  const value = matches[0];
  exactKeys(value, keys);
  if (value.Effect !== "Allow") rejected();
  return value;
}

function validateReleasePolicy(plan, resource, bucketName, expectedTerraformId, appRuntimeId) {
  const value = after(resource);
  if (value.bucket !== bucketName) rejected();
  if (typeof value.policy !== "string") {
    if (onlyCreate(resource) && computed(resource, "policy")) {
      proveExactReferences(plan, resource, "policy", [
        ...releaseBucketReference,
        ...publisherReference,
        "var.terraform_service_account_id",
      ]);
      return;
    }
    rejected();
  }

  let policy;
  try {
    policy = JSON.parse(value.policy);
  } catch {
    rejected();
  }
  exactKeys(policy, ["Version", "Statement"]);
  if (policy.Version !== "2012-10-17" || !Array.isArray(policy.Statement)) rejected();
  if (policy.Statement.length !== 4) rejected();

  const bucketArn = `arn:aws:s3:::${bucketName}`;
  const stationArn = `${bucketArn}/station/*`;
  const publicRead = statement(policy, "AllowPublicStationReleaseObjects", [
    "Sid",
    "Effect",
    "Principal",
    "Action",
    "Resource",
  ]);
  if (publicRead.Principal !== "*") rejected();
  exactStrings(publicRead.Action, ["s3:GetObject"]);
  exactStrings(publicRead.Resource, [stationArn]);

  const publisherObjects = statement(policy, "AllowPublisherStationObjects", [
    "Sid",
    "Effect",
    "Principal",
    "Action",
    "Resource",
  ]);
  const publisherId = canonicalUser(publisherObjects);
  exactStrings(publisherObjects.Action, ["s3:GetObject", "s3:PutObject"]);
  exactStrings(publisherObjects.Resource, [stationArn]);

  const publisherBucket = statement(policy, "AllowPublisherStationBucketPreflight", [
    "Sid",
    "Effect",
    "Principal",
    "Action",
    "Resource",
    "Condition",
  ]);
  if (canonicalUser(publisherBucket) !== publisherId) rejected();
  exactStrings(publisherBucket.Action, ["s3:GetBucketLocation", "s3:ListBucket"]);
  exactStrings(publisherBucket.Resource, [bucketArn]);
  exactKeys(publisherBucket.Condition, ["StringLike"]);
  exactKeys(publisherBucket.Condition.StringLike, ["s3:prefix"]);
  exactStrings(publisherBucket.Condition.StringLike["s3:prefix"], ["station/*"]);

  const terraform = statement(policy, "AllowTerraformReleaseManagement", [
    "Sid",
    "Effect",
    "Principal",
    "Action",
    "Resource",
  ]);
  const terraformId = canonicalUser(terraform);
  if (
    terraformId === publisherId ||
    terraformId !== expectedTerraformId ||
    terraformId === appRuntimeId
  )
    rejected();
  exactStrings(terraform.Action, ["s3:*"]);
  exactStrings(terraform.Resource, [bucketArn, `${bucketArn}/*`]);
}

function validateReleaseBucket(resource) {
  if (includesDelete(resource)) rejected();
  const value = after(resource);
  const bucketName = nonblank(value.bucket);
  if (value.force_destroy !== false) rejected();
  if (value.acl !== null && value.acl !== undefined && value.acl !== "private") rejected();
  if (
    value.grant !== null &&
    value.grant !== undefined &&
    (!Array.isArray(value.grant) || value.grant.length > 0)
  )
    rejected();
  if (!Array.isArray(value.anonymous_access_flags) || value.anonymous_access_flags.length !== 1)
    rejected();
  const anonymous = value.anonymous_access_flags[0];
  if (
    !object(anonymous) ||
    anonymous.read !== true ||
    anonymous.list !== false ||
    anonymous.config_read !== false
  )
    rejected();
  if (!Array.isArray(value.versioning) || value.versioning.length !== 1) rejected();
  if (value.versioning[0]?.enabled !== true) rejected();
  if (Array.isArray(value.lifecycle_rule) && value.lifecycle_rule.length > 0) rejected();
  return bucketName;
}

function validatePublisher(resource) {
  const value = after(resource);
  if (value.name !== "markiro-station-release-publisher") rejected();
}

function validatePublisherKey(plan, resource, publisherId) {
  const value = after(resource);
  if (typeof value.secret_key === "string" && value.secret_key.length > 0) rejected();
  const serviceAccountId = knownOrReferenced(
    plan,
    resource,
    "service_account_id",
    publisherReference,
  );
  if (serviceAccountId !== null && publisherId !== null && serviceAccountId !== publisherId)
    rejected();
  const pgpKey = knownOrComputed(resource, "pgp_key");
  if (pgpKey !== null) nonblank(pgpKey);
}

function validatePublisherBinding(plan, resource, bucketName, publisherId) {
  const value = after(resource);
  if (value.bucket !== bucketName || value.role !== "storage.uploader") rejected();
  const members = knownOrReferenced(plan, resource, "members", publisherReference);
  if (members === null) return;
  if (
    publisherId === null &&
    Array.isArray(members) &&
    members.length === 1 &&
    members[0] === null &&
    resource.change?.after_unknown?.members?.[0] === true
  ) {
    proveExactReferences(plan, resource, "members", publisherReference);
    return;
  }
  if (publisherId === null) rejected();
  exactStrings(members, [`serviceAccount:${publisherId}`]);
}

function validateOriginGroup(resource, bucketName) {
  const value = after(resource);
  if (value.name !== "markiro-station-releases" || value.use_next !== false) rejected();
  if (!Array.isArray(value.origin) || value.origin.length !== 1) rejected();
  const origin = value.origin[0];
  if (!object(origin) || origin.enabled !== true || origin.backup !== false) rejected();
  if (origin.source !== `${bucketName}.storage.yandexcloud.net`) rejected();
  const id = knownOrComputed(resource, "id");
  return id === null ? null : nonblank(id);
}

function validateCertificate(resource) {
  if (includesDelete(resource)) rejected();
  const value = after(resource);
  exactStrings(value.domains, [expectedReleaseDomain]);
  if (!Array.isArray(value.managed) || value.managed.length !== 1) rejected();
  if (value.managed[0]?.challenge_type !== "DNS_CNAME" || value.managed[0]?.challenge_count !== 1)
    rejected();
}

function validateCertificateRecord(resource) {
  const value = after(resource);
  const name = knownOrComputed(resource, "name");
  if (name !== null && (typeof name !== "string" || !name.endsWith(`.${expectedReleaseDomain}.`)))
    rejected();
  const type = knownOrComputed(resource, "type");
  if (type !== null && type !== "CNAME") rejected();
  const data = knownOrComputed(resource, "data");
  if (data !== null && (!Array.isArray(data) || data.length !== 1)) rejected();
}

function validateCdn(plan, resource, expectedOriginGroupId) {
  const value = after(resource);
  const originGroupId = knownOrReferenced(plan, resource, "origin_group_id", originGroupReference);
  if (
    value.cname !== expectedReleaseDomain ||
    value.active !== true ||
    value.origin_protocol !== "https" ||
    (originGroupId !== null && originGroupId !== expectedOriginGroupId)
  )
    rejected();
  if (!Array.isArray(value.options) || value.options.length !== 1) rejected();
  const options = value.options[0];
  exactStrings(options.allowed_http_methods, ["GET", "HEAD"]);
  if (
    options.redirect_http_to_https !== true ||
    options.redirect_https_to_http !== false ||
    options.edge_cache_settings !== 0
  )
    rejected();
  if (options.browser_cache_settings !== null && options.browser_cache_settings !== undefined)
    rejected();
  if (!object(options.static_response_headers)) rejected();
  if (
    options.static_response_headers["x-content-type-options"] !== "nosniff" ||
    options.static_response_headers["content-security-policy"] !==
      "default-src 'none'; frame-ancestors 'none'; sandbox"
  )
    rejected();
  if (!Array.isArray(value.ssl_certificate) || value.ssl_certificate.length !== 1) rejected();
  const certificate = value.ssl_certificate[0];
  if (!object(certificate) || certificate.type !== "certificate_manager") rejected();
  if (
    certificate.certificate_manager_id !== null &&
    certificate.certificate_manager_id !== undefined
  )
    nonblank(certificate.certificate_manager_id);
  const providerCname = knownOrComputed(resource, "provider_cname");
  return providerCname === null ? null : nonblank(providerCname).replace(/\.+$/, "");
}

function validatePublicDns(plan, resource, expectedProviderCname) {
  const value = after(resource);
  if (value.name !== `${expectedReleaseDomain}.` || value.type !== "CNAME") rejected();
  const data = knownOrReferenced(plan, resource, "data", cdnReference);
  if (data === null) return;
  if (!Array.isArray(data) || data.length !== 1 || data[0] !== `${expectedProviderCname}.`)
    rejected();
}

function planVariable(plan, name) {
  const variable = plan.variables?.[name];
  if (!object(variable) || Object.keys(variable).some((key) => key !== "value")) rejected();
  return nonblank(variable.value);
}

function storageCapableRole(role) {
  return (
    typeof role === "string" &&
    (role.startsWith("storage.") || role === "admin" || role === "editor")
  );
}

function containsAppPrincipal(value, appRuntimeId) {
  const principal = `serviceAccount:${appRuntimeId}`;
  if (value === appRuntimeId || value === principal) return true;
  if (Array.isArray(value)) return value.some((item) => containsAppPrincipal(item, appRuntimeId));
  if (object(value))
    return Object.values(value).some((item) => containsAppPrincipal(item, appRuntimeId));
  return false;
}

function rejectApplicationStorageGrants(resource, appRuntimeId, releaseBucketName) {
  for (const value of [resource.change?.before, resource.change?.after]) {
    if (!object(value) || !containsAppPrincipal(value, appRuntimeId)) continue;
    if (
      [
        "yandex_resourcemanager_folder_iam_member",
        "yandex_resourcemanager_folder_iam_binding",
        "yandex_resourcemanager_cloud_iam_member",
        "yandex_resourcemanager_cloud_iam_binding",
      ].includes(resource.type) &&
      storageCapableRole(value.role)
    )
      rejected();
    if (
      [
        "yandex_storage_bucket_iam_binding",
        "yandex_storage_bucket_grant",
        "yandex_storage_bucket_policy",
      ].includes(resource.type) &&
      (value.bucket === releaseBucketName || resource.address.startsWith(releasePrefix))
    )
      rejected();
  }
}

function validateDirectVmDns(resource) {
  if (resource.type !== "yandex_dns_recordset") rejected();
  if (resource.change?.after === null) return;
  const value = after(resource);
  const name = nonblank(value.name).replace(/\.+$/, "").toLowerCase();
  if (name === expectedReleaseDomain) rejected();
}

export function guardProductionPlan(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.resource_changes))
    rejected("plan-shape");

  const expectedTerraformId = scoped("terraform-identity-variable", () =>
    planVariable(plan, "terraform_service_account_id"),
  );
  const appRuntimeId = scoped("app-identity-variable", () =>
    planVariable(plan, "app_service_account_id"),
  );
  if (expectedTerraformId === appRuntimeId) rejected("shared-runtime-identity");

  const seen = new Set();
  const resources = new Map();
  for (const resource of plan.resource_changes) {
    if (!resource || typeof resource !== "object" || typeof resource.address !== "string")
      rejected("resource-shape");
    if (seen.has(resource.address)) rejected("duplicate-resource");
    const expectedType =
      releaseResourceTypes.get(resource.address) ??
      safeProductionResources.get(resource.address) ??
      retiredProductionResources.get(resource.address);
    if (!expectedType || resource.type !== expectedType) rejected("resource-classification");
    const resourceActions = scoped("resource-actions", () => actions(resource));
    if (
      retiredProductionResources.has(resource.address) &&
      (resourceActions.length !== 1 ||
        resourceActions[0] !== "delete" ||
        resource.change?.after !== null)
    )
      rejected("retired-resource-action");
    if (safeProductionResources.has(resource.address)) {
      const allowed = directVmDnsAddresses.has(resource.address)
        ? ["no-op", "create", "update", "delete"]
        : resource.address.includes(".data.")
          ? ["no-op", "read"]
          : ["no-op"];
      if (!onlyAllowedAction(resourceActions, allowed)) rejected("safe-resource-action");
    }
    if (
      resource.address === "module.station_releases.data.yandex_cm_certificate.issued" &&
      !onlyAllowedAction(resourceActions, ["no-op", "read"])
    )
      rejected("release-data-action");
    if (
      releaseResourceTypes.has(resource.address) &&
      resource.address !== "module.station_releases.data.yandex_cm_certificate.issued"
    ) {
      const allowed =
        resource.address === "module.station_releases.yandex_dns_recordset.public_release[0]"
          ? ["no-op", "create", "update", "delete"]
          : ["no-op", "create", "update"];
      if (!onlyAllowedAction(resourceActions, allowed)) rejected("release-resource-action");
    }
    if (
      releaseResourceTypes.has(resource.address) &&
      resource.address !== "module.station_releases.yandex_dns_recordset.public_release[0]" &&
      resourceActions.includes("delete")
    )
      rejected("release-resource-delete");
    if (protectedAddresses.has(resource.address) && resourceActions.includes("delete"))
      rejected("protected-resource-delete");
    seen.add(resource.address);
    resources.set(resource.address, resource);
  }

  for (const address of protectedAddresses)
    if (!seen.has(address)) rejected("missing-protected-resource");
  for (const address of requiredReleaseAddresses)
    if (!seen.has(address)) rejected("missing-release-resource");
  for (const address of directVmDnsAddresses) {
    const resource = resources.get(address);
    if (resource) scoped("direct-vm-dns", () => validateDirectVmDns(resource));
  }

  const bucket = resources.get("module.station_releases.yandex_storage_bucket.releases");
  const bucketName = scoped("release-bucket", () => validateReleaseBucket(bucket));
  const publisher = resources.get(
    "module.station_releases.yandex_iam_service_account.station_release_publisher",
  );
  const publisherIdValue = scoped("release-publisher", () => {
    validatePublisher(publisher);
    const value = knownOrComputed(publisher, "id");
    if (value !== null) nonblank(value);
    return value;
  });
  scoped("release-publisher-key", () =>
    validatePublisherKey(
      plan,
      resources.get(
        "module.station_releases.yandex_iam_service_account_static_access_key.publisher",
      ),
      publisherIdValue,
    ),
  );
  scoped("release-publisher-binding", () =>
    validatePublisherBinding(
      plan,
      resources.get("module.station_releases.yandex_storage_bucket_iam_binding.publisher_uploader"),
      bucketName,
      publisherIdValue,
    ),
  );
  scoped("release-policy", () =>
    validateReleasePolicy(
      plan,
      resources.get("module.station_releases.yandex_storage_bucket_policy.releases"),
      bucketName,
      expectedTerraformId,
      appRuntimeId,
    ),
  );
  const releaseOriginGroupId = scoped("release-origin-group", () =>
    validateOriginGroup(
      resources.get("module.station_releases.yandex_cdn_origin_group.releases"),
      bucketName,
    ),
  );
  scoped("release-certificate", () =>
    validateCertificate(resources.get("module.station_releases.yandex_cm_certificate.releases")),
  );
  scoped("release-certificate-dns", () =>
    validateCertificateRecord(
      resources.get("module.station_releases.yandex_dns_recordset.certificate_validation[0]"),
    ),
  );
  const cdn = resources.get("module.station_releases.yandex_cdn_resource.releases");
  const publicDns = resources.get("module.station_releases.yandex_dns_recordset.public_release[0]");
  const publicDnsLive =
    publicDns && (publicDns.change?.before !== null || publicDns.change?.after !== null);
  if (scoped("release-cdn-actions", () => includesDelete(cdn)) && publicDnsLive)
    rejected("release-cdn-delete");
  const providerCname = scoped("release-cdn", () =>
    cdn.change?.after !== null ? validateCdn(plan, cdn, releaseOriginGroupId) : null,
  );
  if (publicDns && publicDns.change?.after !== null) {
    scoped("release-public-dns", () => validatePublicDns(plan, publicDns, providerCname));
  }

  for (const resource of plan.resource_changes) {
    scoped("application-storage-grant", () =>
      rejectApplicationStorageGrants(resource, appRuntimeId, bucketName),
    );
    if (
      resource.address ===
        "module.station_releases.yandex_storage_bucket_iam_binding.publisher_uploader" ||
      resource.address === "module.station_releases.yandex_storage_bucket_policy.releases"
    )
      continue;
    const bucketReference = resource.change?.after?.bucket ?? resource.change?.before?.bucket;
    if (
      bucketReference === bucketName &&
      [
        "yandex_storage_bucket_iam_binding",
        "yandex_storage_bucket_grant",
        "yandex_storage_bucket_policy",
      ].includes(resource.type)
    )
      rejected("duplicate-release-bucket-control");
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    if (process.argv.length !== 3) throw new Error();
    guardProductionPlan(JSON.parse(await readFile(process.argv[2], "utf8")));
  } catch (error) {
    const message =
      error instanceof Error && /^production plan rejected(?: \([a-z0-9-]+\))?$/.test(error.message)
        ? error.message
        : "production plan rejected";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
