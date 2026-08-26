import { readFile } from "node:fs/promises";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

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
const safeProductionActionScopes = new Map([
  ["module.network.yandex_vpc_network.production", "safe-action-network"],
  ["module.network.yandex_vpc_gateway.nat", "safe-action-nat-gateway"],
  ["module.network.yandex_vpc_route_table.private_egress", "safe-action-private-egress"],
  ["module.network.yandex_vpc_subnet.app", "safe-action-app-subnet"],
  ["module.network.yandex_vpc_subnet.data", "safe-action-data-subnet"],
  ["module.network.yandex_vpc_security_group.app", "safe-action-app-security-group"],
  ["module.network.yandex_vpc_security_group.data", "safe-action-data-security-group"],
  ["module.compute.data.yandex_compute_image.ubuntu_lts", "safe-action-ubuntu-image"],
  ["module.compute.yandex_vpc_address.app", "safe-action-app-address"],
  ["module.compute.yandex_compute_instance.app", "safe-action-app-compute"],
  ["module.postgres.yandex_mdb_postgresql_cluster.production", "safe-action-postgres-cluster"],
  ["module.postgres.yandex_mdb_postgresql_database.application", "safe-action-postgres-database"],
  ["module.object_storage.yandex_storage_bucket.media", "safe-action-media-bucket"],
  ["module.object_storage.yandex_storage_bucket.audit", "safe-action-audit-bucket"],
  ["module.object_storage.yandex_storage_bucket_policy.media_app", "safe-action-media-policy"],
  [
    "module.object_storage.yandex_storage_bucket_iam_binding.app_uploader",
    "safe-action-app-uploader-binding",
  ],
]);
const appComputeAddress = "module.compute.yandex_compute_instance.app";
const appComputeFieldScopes = new Map([
  ["allow_stopping_for_update", "allow-stopping"],
  ["boot_disk", "boot-disk"],
  ["deletion_protection", "deletion-protection"],
  ["description", "description"],
  ["dns_record", "dns-record"],
  ["filesystem", "filesystem"],
  ["folder_id", "folder"],
  ["fqdn", "fqdn"],
  ["gpu_cluster_id", "gpu-cluster"],
  ["hardware_generation", "hardware-generation"],
  ["hostname", "hostname"],
  ["id", "id"],
  ["labels", "labels"],
  ["local_disk", "local-disk"],
  ["maintenance_grace_period", "maintenance-grace-period"],
  ["metadata", "metadata"],
  ["name", "name"],
  ["network_acceleration_type", "network-acceleration"],
  ["network_interface", "network-interface"],
  ["placement_policy", "placement-policy"],
  ["platform_id", "platform"],
  ["resources", "resources"],
  ["scheduling_policy", "scheduling-policy"],
  ["secondary_disk", "secondary-disk"],
  ["service_account_id", "service-account"],
  ["status", "status"],
  ["zone", "zone"],
]);
const appComputeMetadataFieldScopes = new Map([
  ["enable-oslogin", "enable-oslogin"],
  ["serial-port-enable", "serial-port-enable"],
  ["ssh-keys", "ssh-keys"],
  ["user-data", "user-data"],
]);
const appSecurityGroupAddress = "module.network.yandex_vpc_security_group.app";
const dataSecurityGroupAddress = "module.network.yandex_vpc_security_group.data";
const dataSecurityGroupIngressDescription = "Only the application may reach the PostgreSQL pooler.";
const securityGroupFieldScopes = new Map([
  ["description", "description"],
  ["egress", "egress"],
  ["folder_id", "folder"],
  ["id", "id"],
  ["ingress", "ingress"],
  ["labels", "labels"],
  ["name", "name"],
  ["network_id", "network"],
  ["status", "status"],
]);
const securityGroupRuleFieldScopes = new Map([
  ["description", "description"],
  ["from_port", "from-port"],
  ["id", "id"],
  ["labels", "labels"],
  ["port", "port"],
  ["predefined_target", "predefined-target"],
  ["protocol", "protocol"],
  ["security_group_id", "security-group"],
  ["to_port", "to-port"],
  ["v4_cidr_blocks", "v4-cidrs"],
  ["v6_cidr_blocks", "v6-cidrs"],
]);
const securityGroupRuleSemanticFieldScopes = new Map([
  ["description", "description"],
  ["portRange", "port-range"],
  ["predefinedTarget", "predefined-target"],
  ["protocol", "protocol"],
  ["securityGroupId", "security-group"],
  ["v4Cidrs", "v4-cidrs"],
  ["v6Cidrs", "v6-cidrs"],
]);
const securityGroupRuleKeys = [
  "description",
  "from_port",
  "id",
  "labels",
  "port",
  "predefined_target",
  "protocol",
  "security_group_id",
  "to_port",
  "v4_cidr_blocks",
  "v6_cidr_blocks",
];

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

function changedKeys(beforeValue, afterValue) {
  if (!object(beforeValue) || !object(afterValue)) return null;
  return [...new Set([...Object.keys(beforeValue), ...Object.keys(afterValue)])]
    .sort()
    .filter((key) => !isDeepStrictEqual(beforeValue[key], afterValue[key]));
}

function stableValueSignature(value) {
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => stableValueSignature(item))
      .sort()
      .join(",")}]`;
  }
  if (object(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValueSignature(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function changedArrayObjectKeys(beforeValue, afterValue) {
  if (
    !Array.isArray(beforeValue) ||
    !Array.isArray(afterValue) ||
    beforeValue.some((item) => !object(item)) ||
    afterValue.some((item) => !object(item))
  )
    return null;

  const keys = [
    ...new Set([
      ...beforeValue.flatMap((item) => Object.keys(item)),
      ...afterValue.flatMap((item) => Object.keys(item)),
    ]),
  ].sort();
  const signatures = (items, key) =>
    items
      .map((item) =>
        Object.hasOwn(item, key) ? `present:${stableValueSignature(item[key])}` : "absent",
      )
      .sort();
  return keys.filter(
    (key) => !isDeepStrictEqual(signatures(beforeValue, key), signatures(afterValue, key)),
  );
}

function containsUnknown(value) {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some((item) => containsUnknown(item));
  if (object(value)) return Object.values(value).some((item) => containsUnknown(item));
  return false;
}

function unknownArrayObjectKeys(value) {
  if (!Array.isArray(value) || value.some((item) => !object(item))) return null;
  return [
    ...new Set(
      value.flatMap((item) =>
        Object.entries(item)
          .filter(([, fieldValue]) => containsUnknown(fieldValue))
          .map(([field]) => field),
      ),
    ),
  ].sort();
}

function securityGroupRuleSemanticValue(rule) {
  if (!object(rule) || typeof rule.protocol !== "string") return null;
  const optionalString = (value) => {
    if (value === null || value === undefined) return "";
    return typeof value === "string" ? value : null;
  };
  const stringArray = (value) => {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
    return [...value].sort();
  };
  const port = rule.port ?? -1;
  const fromPort = rule.from_port ?? -1;
  const toPort = rule.to_port ?? -1;
  if (![port, fromPort, toPort].every((value) => Number.isInteger(value))) return null;
  const description = optionalString(rule.description);
  const securityGroupId = optionalString(rule.security_group_id);
  const predefinedTarget = optionalString(rule.predefined_target);
  const v4Cidrs = stringArray(rule.v4_cidr_blocks);
  const v6Cidrs = stringArray(rule.v6_cidr_blocks);
  if (
    description === null ||
    securityGroupId === null ||
    predefinedTarget === null ||
    v4Cidrs === null ||
    v6Cidrs === null
  )
    return null;
  const portRange = port !== -1 ? [port, port] : [fromPort, toPort];
  return {
    description,
    portRange,
    predefinedTarget,
    protocol: rule.protocol.toUpperCase(),
    securityGroupId,
    v4Cidrs,
    v6Cidrs,
  };
}

function securityGroupRuleSemanticSignature(rule) {
  const value = securityGroupRuleSemanticValue(rule);
  return value === null ? null : stableValueSignature(value);
}

function securityGroupRuleSemanticDifferenceScopes(leftRule, rightRule) {
  const leftValue = securityGroupRuleSemanticValue(leftRule);
  const rightValue = securityGroupRuleSemanticValue(rightRule);
  if (leftValue === null || rightValue === null) return null;
  const fields = changedKeys(leftValue, rightValue);
  if (!fields) return null;
  return fields.map((field) => securityGroupRuleSemanticFieldScopes.get(field) ?? "other");
}

function ipv4CidrScope(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(value);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => !Number.isInteger(octet) || octet > 255) || prefix > 32) return null;

  const address = octets.reduce((result, octet) => result * 256n + BigInt(octet), 0n);
  const blockSize = 1n << BigInt(32 - prefix);
  const start = address - (address % blockSize);
  const end = start + blockSize - 1n;
  if (start === 0n && end === 4294967295n) return "world";

  const privateRanges = [
    [167772160n, 184549375n],
    [2886729728n, 2887778303n],
    [3232235520n, 3232301055n],
  ];
  if (
    privateRanges.some(([privateStart, privateEnd]) => start >= privateStart && end <= privateEnd)
  )
    return "private";
  return "other";
}

function unmatchedSecurityGroupSourceScope(rule) {
  const value = securityGroupRuleSemanticValue(rule);
  if (value === null) return null;
  const v4Scopes = value.v4Cidrs.map((cidr) => ipv4CidrScope(cidr));
  if (v4Scopes.some((scope) => scope === null)) return null;
  const uniqueV4Scopes = [...new Set(v4Scopes)].sort();
  const v4Scope = uniqueV4Scopes.length === 0 ? "none" : uniqueV4Scopes.join("-and-");
  const securityGroupScope = value.securityGroupId === "" ? "empty" : "present";
  return `security-group-${securityGroupScope}-v4-cidrs-count-${value.v4Cidrs.length}-v4-scopes-${v4Scope}`;
}

function hasExactKeys(value, expected) {
  if (!object(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function exactPortRange(value, port) {
  return Array.isArray(value) && value.length === 2 && value.every((item) => item === port);
}

function isConfirmedExternalDataIngressRemoval(plan, resource, resourceActions) {
  if (
    resource.address !== dataSecurityGroupAddress ||
    resource.type !== "yandex_vpc_security_group" ||
    resourceActions.length !== 1 ||
    resourceActions[0] !== "update" ||
    containsUnknown(resource.change?.after_unknown)
  )
    return false;

  const beforeValue = resource.change?.before;
  const afterValue = resource.change?.after;
  const fields = changedKeys(beforeValue, afterValue);
  if (
    !fields ||
    fields.length !== 1 ||
    fields[0] !== "ingress" ||
    !Array.isArray(beforeValue.ingress) ||
    beforeValue.ingress.length !== 2 ||
    !Array.isArray(afterValue.ingress) ||
    afterValue.ingress.length !== 1
  )
    return false;

  const desiredRule = afterValue.ingress[0];
  if (!hasExactKeys(desiredRule, securityGroupRuleKeys)) return false;
  const desiredValue = securityGroupRuleSemanticValue(desiredRule);
  if (
    desiredValue === null ||
    desiredValue.description !== dataSecurityGroupIngressDescription ||
    !exactPortRange(desiredValue.portRange, 6432) ||
    desiredValue.predefinedTarget !== "" ||
    desiredValue.protocol !== "TCP" ||
    desiredValue.v4Cidrs.length !== 0 ||
    desiredValue.v6Cidrs.length !== 0
  )
    return false;

  const appResources = plan.resource_changes.filter(
    (candidate) =>
      candidate?.address === appSecurityGroupAddress &&
      candidate?.type === "yandex_vpc_security_group",
  );
  if (appResources.length !== 1) return false;
  const appResource = appResources[0];
  if (
    !Array.isArray(appResource.change?.actions) ||
    appResource.change.actions.length !== 1 ||
    appResource.change.actions[0] !== "no-op" ||
    !object(appResource.change?.after) ||
    typeof appResource.change.after.id !== "string" ||
    appResource.change.after.id.length === 0 ||
    desiredValue.securityGroupId !== appResource.change.after.id
  )
    return false;

  const desiredSignature = securityGroupRuleSemanticSignature(desiredRule);
  const matchingRules = beforeValue.ingress.filter(
    (rule) => securityGroupRuleSemanticSignature(rule) === desiredSignature,
  );
  if (
    desiredSignature === null ||
    matchingRules.length !== 1 ||
    !hasExactKeys(matchingRules[0], securityGroupRuleKeys)
  )
    return false;
  const unmatchedRules = beforeValue.ingress.filter(
    (rule) => securityGroupRuleSemanticSignature(rule) !== desiredSignature,
  );
  if (unmatchedRules.length !== 1) return false;
  const unmatchedRule = unmatchedRules[0];
  if (!hasExactKeys(unmatchedRule, securityGroupRuleKeys)) return false;
  const unmatchedValue = securityGroupRuleSemanticValue(unmatchedRule);
  return (
    unmatchedValue !== null &&
    unmatchedValue.description !== dataSecurityGroupIngressDescription &&
    exactPortRange(unmatchedValue.portRange, 6432) &&
    unmatchedValue.predefinedTarget === "" &&
    unmatchedValue.protocol === "TCP" &&
    unmatchedValue.securityGroupId === "" &&
    unmatchedValue.v4Cidrs.length === 1 &&
    ipv4CidrScope(unmatchedValue.v4Cidrs[0]) === "other" &&
    unmatchedValue.v6Cidrs.length === 0
  );
}

function appComputeActionScope(resource) {
  const beforeValue = resource.change?.before;
  const afterValue = resource.change?.after;
  const fields = changedKeys(beforeValue, afterValue);
  if (!fields || fields.length === 0) return "safe-action-app-compute";

  const scopes = fields.map((field) => {
    if (field !== "metadata") return appComputeFieldScopes.get(field) ?? "other";
    const metadataFields = changedKeys(beforeValue.metadata, afterValue.metadata);
    if (!metadataFields || metadataFields.length === 0) return "metadata";
    const metadataScopes = [
      ...new Set(
        metadataFields.map((metadataField) => {
          return appComputeMetadataFieldScopes.get(metadataField) ?? "other";
        }),
      ),
    ].sort();
    return `metadata-${metadataScopes.join("-and-")}`;
  });
  const uniqueScopes = [...new Set(scopes)].sort();
  if (uniqueScopes.length === 1 && uniqueScopes[0] === "other") return "safe-action-app-compute";
  return `safe-action-app-compute-${uniqueScopes.join("-and-")}`;
}

function securityGroupActionScope(resource, baseScope) {
  const beforeValue = resource.change?.before;
  const afterValue = resource.change?.after;
  const fields = changedKeys(beforeValue, afterValue);
  if (!fields || fields.length === 0) return baseScope;

  const scopes = [
    ...new Set(
      fields.map((field) => {
        if (field !== "ingress") return securityGroupFieldScopes.get(field) ?? "other";
        if (resource.change?.after_unknown?.ingress === true) return "ingress-after-unknown";
        const unknownIngressFields = unknownArrayObjectKeys(
          resource.change?.after_unknown?.ingress,
        );
        if (unknownIngressFields?.length) {
          const unknownIngressScopes = [
            ...new Set(
              unknownIngressFields.map(
                (ingressField) => securityGroupRuleFieldScopes.get(ingressField) ?? "other",
              ),
            ),
          ].sort();
          return `ingress-after-unknown-${unknownIngressScopes.join("-and-")}`;
        }
        if (
          Array.isArray(beforeValue.ingress) &&
          Array.isArray(afterValue.ingress) &&
          beforeValue.ingress.length !== afterValue.ingress.length
        ) {
          let desiredMatches = "";
          if (afterValue.ingress.length === 1) {
            const desiredSignature = securityGroupRuleSemanticSignature(afterValue.ingress[0]);
            const liveSignatures = beforeValue.ingress.map((rule) =>
              securityGroupRuleSemanticSignature(rule),
            );
            if (
              desiredSignature !== null &&
              liveSignatures.every((signature) => signature !== null)
            ) {
              const matchCount = liveSignatures.filter(
                (signature) => signature === desiredSignature,
              ).length;
              desiredMatches = `-desired-matches-before-${matchCount}`;
              if (matchCount === 1 && beforeValue.ingress.length === 2) {
                const unmatchedRule = beforeValue.ingress.find(
                  (_rule, index) => liveSignatures[index] !== desiredSignature,
                );
                const differenceScopes = securityGroupRuleSemanticDifferenceScopes(
                  afterValue.ingress[0],
                  unmatchedRule,
                );
                if (differenceScopes?.length) {
                  desiredMatches += `-unmatched-diff-${differenceScopes.join("-and-")}`;
                }
                const sourceScope = unmatchedSecurityGroupSourceScope(unmatchedRule);
                if (sourceScope !== null) {
                  desiredMatches += `-unmatched-source-${sourceScope}`;
                }
              }
            }
          }
          return `ingress-cardinality-before-${beforeValue.ingress.length}-after-${afterValue.ingress.length}${desiredMatches}`;
        }
        const ingressFields = changedArrayObjectKeys(beforeValue.ingress, afterValue.ingress);
        if (!ingressFields || ingressFields.length === 0) return "ingress";
        const ingressScopes = [
          ...new Set(
            ingressFields.map(
              (ingressField) => securityGroupRuleFieldScopes.get(ingressField) ?? "other",
            ),
          ),
        ].sort();
        return `ingress-${ingressScopes.join("-and-")}`;
      }),
    ),
  ].sort();
  if (scopes.length === 1 && scopes[0] === "other") return baseScope;
  return `${baseScope}-${scopes.join("-and-")}`;
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

function releasePolicyScoped(scope, callback) {
  return scoped(`release-policy-${scope}`, callback);
}

function validateReleasePolicy(plan, resource, bucketName, expectedTerraformId, appRuntimeId) {
  const value = releasePolicyScoped("resource", () => after(resource));
  releasePolicyScoped("bucket", () => {
    if (value.bucket !== bucketName) rejected();
  });
  if (typeof value.policy !== "string") {
    releasePolicyScoped("computed-value", () => {
      if (!onlyCreate(resource) || !computed(resource, "policy")) rejected();
    });
    releasePolicyScoped("computed-references", () => {
      proveExactReferences(plan, resource, "policy", [
        ...releaseBucketReference,
        ...publisherReference,
        "var.terraform_service_account_id",
      ]);
    });
    return;
  }

  const policy = releasePolicyScoped("json", () => JSON.parse(value.policy));
  releasePolicyScoped("shape", () => {
    exactKeys(policy, ["Version", "Statement"]);
    if (!Array.isArray(policy.Statement)) rejected();
  });
  releasePolicyScoped("version", () => {
    if (policy.Version !== "2012-10-17") rejected();
  });
  releasePolicyScoped("statement-count", () => {
    if (policy.Statement.length !== 4) rejected();
  });

  const bucketArn = `arn:aws:s3:::${bucketName}`;
  const stationArn = `${bucketArn}/station/*`;
  const publicRead = releasePolicyScoped("public-statement", () =>
    statement(policy, "AllowPublicStationReleaseObjects", [
      "Sid",
      "Effect",
      "Principal",
      "Action",
      "Resource",
    ]),
  );
  releasePolicyScoped("public-principal", () => {
    if (publicRead.Principal !== "*") rejected();
  });
  releasePolicyScoped("public-action", () => exactStrings(publicRead.Action, ["s3:GetObject"]));
  releasePolicyScoped("public-resource", () => exactStrings(publicRead.Resource, [stationArn]));

  const publisherObjects = releasePolicyScoped("publisher-objects-statement", () =>
    statement(policy, "AllowPublisherStationObjects", [
      "Sid",
      "Effect",
      "Principal",
      "Action",
      "Resource",
    ]),
  );
  const publisherId = releasePolicyScoped("publisher-objects-principal", () =>
    canonicalUser(publisherObjects),
  );
  releasePolicyScoped("publisher-objects-action", () =>
    exactStrings(publisherObjects.Action, ["s3:GetObject", "s3:PutObject"]),
  );
  releasePolicyScoped("publisher-objects-resource", () =>
    exactStrings(publisherObjects.Resource, [stationArn]),
  );

  const publisherBucket = releasePolicyScoped("publisher-bucket-statement", () =>
    statement(policy, "AllowPublisherStationBucketPreflight", [
      "Sid",
      "Effect",
      "Principal",
      "Action",
      "Resource",
      "Condition",
    ]),
  );
  releasePolicyScoped("publisher-bucket-principal", () => {
    if (canonicalUser(publisherBucket) !== publisherId) rejected();
  });
  releasePolicyScoped("publisher-bucket-action", () =>
    exactStrings(publisherBucket.Action, ["s3:GetBucketLocation", "s3:ListBucket"]),
  );
  releasePolicyScoped("publisher-bucket-resource", () =>
    exactStrings(publisherBucket.Resource, [bucketArn]),
  );
  releasePolicyScoped("publisher-bucket-condition", () => {
    exactKeys(publisherBucket.Condition, ["StringLike"]);
    exactKeys(publisherBucket.Condition.StringLike, ["s3:prefix"]);
    exactStrings(publisherBucket.Condition.StringLike["s3:prefix"], ["station/*"]);
  });

  const terraform = releasePolicyScoped("terraform-statement", () =>
    statement(policy, "AllowTerraformReleaseManagement", [
      "Sid",
      "Effect",
      "Principal",
      "Action",
      "Resource",
    ]),
  );
  const terraformId = releasePolicyScoped("terraform-principal", () => canonicalUser(terraform));
  releasePolicyScoped("terraform-identity", () => {
    if (
      terraformId === publisherId ||
      terraformId !== expectedTerraformId ||
      terraformId === appRuntimeId
    )
      rejected();
  });
  releasePolicyScoped("terraform-action", () => exactStrings(terraform.Action, ["s3:*"]));
  releasePolicyScoped("terraform-resource", () =>
    exactStrings(terraform.Resource, [bucketArn, `${bucketArn}/*`]),
  );
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
      if (!onlyAllowedAction(resourceActions, allowed)) {
        if (!isConfirmedExternalDataIngressRemoval(plan, resource, resourceActions)) {
          const scope =
            resource.address === appComputeAddress
              ? appComputeActionScope(resource)
              : resource.address === appSecurityGroupAddress
                ? securityGroupActionScope(resource, "safe-action-app-security-group")
                : resource.address === dataSecurityGroupAddress
                  ? securityGroupActionScope(resource, "safe-action-data-security-group")
                  : (safeProductionActionScopes.get(resource.address) ?? "safe-resource-action");
          rejected(scope);
        }
      }
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
  validateReleasePolicy(
    plan,
    resources.get("module.station_releases.yandex_storage_bucket_policy.releases"),
    bucketName,
    expectedTerraformId,
    appRuntimeId,
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
    const safeRejection =
      error instanceof Error
        ? /^production plan rejected(?: \(([a-z0-9-]+)\))?$/.exec(error.message)
        : null;
    const message = safeRejection ? error.message : "production plan rejected";
    const scope = safeRejection?.[1];
    if (process.env.GITHUB_ACTIONS === "true" && scope) {
      process.stdout.write(`::error title=Production plan rejected::${scope}\n`);
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
