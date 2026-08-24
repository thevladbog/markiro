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
]);
const requiredReleaseAddresses = new Set(
  [...releaseAddresses].filter(
    (address) => address !== "module.station_releases.yandex_dns_recordset.public_release[0]",
  ),
);
const expectedReleaseDomain = "releases.markiro.app";

function rejected() {
  throw new Error("production plan rejected");
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

function onlyCreate(resource) {
  const value = actions(resource);
  return value.length === 1 && value[0] === "create";
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

function validateReleasePolicy(resource, bucketName) {
  const value = after(resource);
  if (value.bucket !== bucketName) rejected();
  if (typeof value.policy !== "string") {
    if (onlyCreate(resource) && computed(resource, "policy")) return;
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
  if (terraformId === publisherId) rejected();
  exactStrings(terraform.Action, ["s3:*"]);
  exactStrings(terraform.Resource, [bucketArn, `${bucketArn}/*`]);
}

function validateReleaseBucket(resource) {
  if (includesDelete(resource)) rejected();
  const value = after(resource);
  const bucketName = nonblank(value.bucket);
  if (value.force_destroy !== false) rejected();
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

function validatePublisherKey(resource, publisherId) {
  const value = after(resource);
  if (typeof value.secret_key === "string" && value.secret_key.length > 0) rejected();
  const serviceAccountId = knownOrComputed(resource, "service_account_id");
  if (serviceAccountId !== null && publisherId !== null && serviceAccountId !== publisherId)
    rejected();
  const pgpKey = knownOrComputed(resource, "pgp_key");
  if (pgpKey !== null) nonblank(pgpKey);
}

function validatePublisherBinding(resource, bucketName, publisherId) {
  const value = after(resource);
  if (value.bucket !== bucketName || value.role !== "storage.uploader") rejected();
  const members = knownOrComputed(resource, "members");
  if (members === null) return;
  if (
    publisherId === null &&
    onlyCreate(resource) &&
    Array.isArray(members) &&
    members.length === 1 &&
    members[0] === null &&
    resource.change?.after_unknown?.members?.[0] === true
  )
    return;
  if (publisherId === null) rejected();
  exactStrings(members, [`serviceAccount:${publisherId}`]);
}

function validateOriginGroup(resource, bucketName) {
  const value = after(resource);
  if (value.name !== "markiro-station-releases" || value.use_next !== false) rejected();
  if (!Array.isArray(value.origin) || value.origin.length !== 1) rejected();
  const origin = value.origin[0];
  if (!object(origin) || origin.enabled !== true || origin.backup !== false) rejected();
  if (
    origin.source !== null &&
    origin.source !== undefined &&
    origin.source !== `${bucketName}.storage.yandexcloud.net`
  )
    rejected();
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

function validateCdn(resource) {
  const value = after(resource);
  if (
    value.cname !== expectedReleaseDomain ||
    value.active !== true ||
    value.origin_protocol !== "https"
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
}

function validatePublicDns(resource) {
  const value = after(resource);
  if (value.name !== `${expectedReleaseDomain}.` || value.type !== "CNAME") rejected();
  const data = knownOrComputed(resource, "data");
  if (data !== null && (!Array.isArray(data) || data.length !== 1)) rejected();
}

export function guardProductionPlan(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.resource_changes)) rejected();

  const seen = new Set();
  const resources = new Map();
  for (const resource of plan.resource_changes) {
    if (!resource || typeof resource !== "object" || typeof resource.address !== "string")
      rejected();
    const guarded =
      protectedAddresses.has(resource.address) || resource.address.startsWith(releasePrefix);
    if (!guarded) continue;
    if (seen.has(resource.address)) rejected();
    if (resource.address.startsWith(releasePrefix) && !releaseAddresses.has(resource.address))
      rejected();
    const resourceActions = actions(resource);
    if (protectedAddresses.has(resource.address) && resourceActions.includes("delete")) rejected();
    seen.add(resource.address);
    resources.set(resource.address, resource);
  }

  for (const address of protectedAddresses) if (!seen.has(address)) rejected();
  for (const address of requiredReleaseAddresses) if (!seen.has(address)) rejected();

  const bucket = resources.get("module.station_releases.yandex_storage_bucket.releases");
  const bucketName = validateReleaseBucket(bucket);
  const publisher = resources.get(
    "module.station_releases.yandex_iam_service_account.station_release_publisher",
  );
  validatePublisher(publisher);
  const publisherIdValue = knownOrComputed(publisher, "id");
  if (publisherIdValue !== null) nonblank(publisherIdValue);
  validatePublisherKey(
    resources.get("module.station_releases.yandex_iam_service_account_static_access_key.publisher"),
    publisherIdValue,
  );
  validatePublisherBinding(
    resources.get("module.station_releases.yandex_storage_bucket_iam_binding.publisher_uploader"),
    bucketName,
    publisherIdValue,
  );
  validateReleasePolicy(
    resources.get("module.station_releases.yandex_storage_bucket_policy.releases"),
    bucketName,
  );
  validateOriginGroup(
    resources.get("module.station_releases.yandex_cdn_origin_group.releases"),
    bucketName,
  );
  validateCertificate(resources.get("module.station_releases.yandex_cm_certificate.releases"));
  validateCertificateRecord(
    resources.get("module.station_releases.yandex_dns_recordset.certificate_validation[0]"),
  );
  const cdn = resources.get("module.station_releases.yandex_cdn_resource.releases");
  const publicDns = resources.get("module.station_releases.yandex_dns_recordset.public_release[0]");
  if (publicDns && publicDns.change?.after !== null) validatePublicDns(publicDns);
  const publicDnsLive =
    publicDns && (publicDns.change?.before !== null || publicDns.change?.after !== null);
  if (includesDelete(cdn) && publicDnsLive) rejected();
  if (cdn.change?.after !== null) validateCdn(cdn);

  for (const resource of plan.resource_changes) {
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
      rejected();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    if (process.argv.length !== 3) throw new Error();
    guardProductionPlan(JSON.parse(await readFile(process.argv[2], "utf8")));
  } catch {
    process.stderr.write("production plan rejected\n");
    process.exitCode = 1;
  }
}
