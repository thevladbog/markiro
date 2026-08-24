import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { guardProductionPlan } from "../scripts/guard-production-plan.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const script = path.join(root, "infra/yandex/scripts/guard-production-plan.mjs");
const fixture = (name) =>
  path.join(root, "infra/yandex/test/fixtures", `production-plan-${name}.json`);
const retainedProtectedAddresses = [
  "module.compute.yandex_vpc_address.app",
  "module.compute.yandex_compute_instance.app",
  "module.postgres.yandex_mdb_postgresql_cluster.production",
  "module.postgres.yandex_mdb_postgresql_database.application",
  "module.object_storage.yandex_storage_bucket.media",
  "module.object_storage.yandex_storage_bucket.audit",
];
const directVmDnsAddresses = [
  "yandex_dns_recordset.application[0]",
  "yandex_dns_recordset.saas_admin_application[0]",
  "yandex_dns_recordset.kiosk_application[0]",
  "yandex_dns_recordset.landing_application[0]",
];

async function readFixture(name) {
  return JSON.parse(await readFile(fixture(name), "utf8"));
}

function copy(value) {
  return structuredClone(value);
}

function resource(plan, address) {
  const found = plan.resource_changes.find((candidate) => candidate.address === address);
  assert.ok(found, `missing fixture resource ${address}`);
  return found;
}

async function withPlan(plan, callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "markiro-release-plan-guard-"));
  const planPath = path.join(directory, "plan.json");
  try {
    await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
    return callback(planPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function reject(plan) {
  assert.throws(() => guardProductionPlan(plan), /production plan rejected/);
}

test("production plan guard accepts the exact non-destructive Station release graph", async () => {
  const safe = await readFixture("safe");
  assert.doesNotThrow(() => guardProductionPlan(safe));
  execFileSync(process.execPath, [script, fixture("safe")], { cwd: root, stdio: "pipe" });

  const creation = copy(safe);
  creation.resource_changes = creation.resource_changes.filter(
    (candidate) =>
      candidate.address !== "module.station_releases.yandex_dns_recordset.public_release[0]",
  );
  for (const change of creation.resource_changes.filter((candidate) =>
    candidate.address.startsWith("module.station_releases."),
  )) {
    change.change.actions = ["create"];
    change.change.before = null;
  }
  const publisher = resource(
    creation,
    "module.station_releases.yandex_iam_service_account.station_release_publisher",
  );
  publisher.change.after.id = null;
  publisher.change.after_unknown = { id: true };
  const key = resource(
    creation,
    "module.station_releases.yandex_iam_service_account_static_access_key.publisher",
  );
  key.change.after.service_account_id = null;
  key.change.after.access_key = null;
  key.change.after.encrypted_secret_key = null;
  key.change.after_unknown = {
    service_account_id: true,
    access_key: true,
    encrypted_secret_key: true,
  };
  const binding = resource(
    creation,
    "module.station_releases.yandex_storage_bucket_iam_binding.publisher_uploader",
  );
  binding.change.after.members = [null];
  binding.change.after_unknown = { members: [true] };
  const policy = resource(
    creation,
    "module.station_releases.yandex_storage_bucket_policy.releases",
  );
  policy.change.after.policy = null;
  policy.change.after_unknown = { policy: true };
  const origin = resource(creation, "module.station_releases.yandex_cdn_origin_group.releases");
  origin.change.after.origin[0].source = null;
  origin.change.after_unknown = { origin: [{ source: true }] };
  const validation = resource(
    creation,
    "module.station_releases.yandex_dns_recordset.certificate_validation[0]",
  );
  validation.change.after.name = null;
  validation.change.after.type = null;
  validation.change.after.data = null;
  validation.change.after_unknown = { name: true, type: true, data: true };
  const cdn = resource(creation, "module.station_releases.yandex_cdn_resource.releases");
  cdn.change.after.ssl_certificate[0].certificate_manager_id = null;
  cdn.change.after_unknown = {
    ssl_certificate: [{ certificate_manager_id: true }],
  };
  assert.doesNotThrow(() => guardProductionPlan(creation));
});

test("production plan guard rejects the committed unsafe release-bucket fixture", async () => {
  const unsafe = await readFixture("unsafe");
  reject(unsafe);
  assert.throws(() =>
    execFileSync(process.execPath, [script, fixture("unsafe")], {
      cwd: root,
      stdio: "pipe",
    }),
  );
});

test("production plan guard retains every pre-existing protected production address", async () => {
  const safe = await readFixture("safe");
  for (const address of retainedProtectedAddresses) {
    const missing = copy(safe);
    missing.resource_changes = missing.resource_changes.filter(
      (candidate) => candidate.address !== address,
    );
    reject(missing);

    const destructive = copy(safe);
    resource(destructive, address).change.actions = ["delete"];
    resource(destructive, address).change.after = null;
    reject(destructive);
  }
});

test("production plan guard allows direct-VM DNS updates except to the release hostname", async () => {
  const safe = await readFixture("safe");
  for (const address of directVmDnsAddresses) {
    const legitimate = copy(safe);
    legitimate.resource_changes.push({
      address,
      type: "yandex_dns_recordset",
      change: {
        actions: ["update"],
        before: { name: "admin.markiro.app.", type: "A" },
        after: { name: "office.markiro.app.", type: "A" },
      },
    });
    assert.doesNotThrow(() => guardProductionPlan(legitimate));

    const bypass = copy(legitimate);
    resource(bypass, address).change.after.name = "releases.markiro.app.";
    reject(bypass);
    await withPlan(bypass, (planPath) =>
      assert.throws(() =>
        execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" }),
      ),
    );
  }
});

test("production plan guard rejects public bucket ACLs and inline grants", async () => {
  const safe = await readFixture("safe");
  const bucketAddress = "module.station_releases.yandex_storage_bucket.releases";
  const mutations = [
    (plan) => {
      resource(plan, bucketAddress).change.after.acl = "public-read";
    },
    (plan) => {
      resource(plan, bucketAddress).change.after.acl = "public-read-write";
    },
    (plan) => {
      resource(plan, bucketAddress).change.after.grant = [
        {
          id: null,
          permissions: ["READ"],
          type: "Group",
          uri: "http://acs.amazonaws.com/groups/global/AllUsers",
        },
      ];
    },
  ];

  for (const mutate of mutations) {
    const plan = copy(safe);
    mutate(plan);
    reject(plan);
    await withPlan(plan, (planPath) =>
      assert.throws(() =>
        execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" }),
      ),
    );
  }
});

test("production plan guard rejects destructive or weakened release-origin changes", async () => {
  const safe = await readFixture("safe");
  const bucketAddress = "module.station_releases.yandex_storage_bucket.releases";
  const policyAddress = "module.station_releases.yandex_storage_bucket_policy.releases";
  const certificateAddress = "module.station_releases.yandex_cm_certificate.releases";
  const cdnAddress = "module.station_releases.yandex_cdn_resource.releases";
  const dnsAddress = "module.station_releases.yandex_dns_recordset.public_release[0]";

  const mutations = [
    (plan) => {
      resource(plan, bucketAddress).change.actions = ["delete"];
      resource(plan, bucketAddress).change.after = null;
    },
    (plan) => {
      resource(plan, bucketAddress).change.after.versioning[0].enabled = false;
    },
    (plan) => {
      resource(plan, bucketAddress).change.after.anonymous_access_flags[0].list = true;
    },
    (plan) => {
      resource(plan, bucketAddress).change.after.anonymous_access_flags[0].config_read = true;
    },
    (plan) => {
      const policyChange = resource(plan, policyAddress).change;
      const policy = JSON.parse(policyChange.after.policy);
      policy.Statement.find(
        (statement) => statement.Sid === "AllowPublisherStationObjects",
      ).Action.push("s3:DeleteObject");
      policyChange.after.policy = JSON.stringify(policy);
    },
    (plan) => {
      const policyChange = resource(plan, policyAddress).change;
      const policy = JSON.parse(policyChange.after.policy);
      policy.Statement.push({
        Sid: "AllowApplicationRuntimeReleaseObjects",
        Effect: "Allow",
        Principal: { CanonicalUser: "app-runtime-sa-id" },
        Action: ["s3:GetObject"],
        Resource: ["arn:aws:s3:::markiro-station-releases/station/*"],
      });
      policyChange.after.policy = JSON.stringify(policy);
    },
    (plan) => {
      resource(plan, certificateAddress).change.actions = ["delete"];
      resource(plan, certificateAddress).change.after = null;
    },
    (plan) => {
      resource(plan, cdnAddress).change.actions = ["delete"];
      resource(plan, cdnAddress).change.after = null;
      assert.ok(resource(plan, dnsAddress).change.before);
    },
    (plan) => {
      resource(plan, cdnAddress).change.after.cname = "unexpected.markiro.app";
    },
    (plan) => {
      resource(plan, dnsAddress).change.after.name = "unexpected.markiro.app.";
    },
    (plan) => {
      plan.resource_changes.push({
        address: "module.station_releases.yandex_storage_bucket.unexpected",
        type: "yandex_storage_bucket",
        change: { actions: ["create"], before: null, after: {} },
      });
    },
  ];

  for (const mutate of mutations) {
    const plan = copy(safe);
    mutate(plan);
    reject(plan);
    await withPlan(plan, (planPath) =>
      assert.throws(() =>
        execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" }),
      ),
    );
  }
});
