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
const fixedSafeActionScopes = [
  ["module.network.yandex_vpc_network.production", "yandex_vpc_network", "safe-action-network"],
  ["module.network.yandex_vpc_gateway.nat", "yandex_vpc_gateway", "safe-action-nat-gateway"],
  [
    "module.network.yandex_vpc_route_table.private_egress",
    "yandex_vpc_route_table",
    "safe-action-private-egress",
  ],
  ["module.network.yandex_vpc_subnet.app", "yandex_vpc_subnet", "safe-action-app-subnet"],
  ["module.network.yandex_vpc_subnet.data", "yandex_vpc_subnet", "safe-action-data-subnet"],
  [
    "module.network.yandex_vpc_security_group.app",
    "yandex_vpc_security_group",
    "safe-action-app-security-group",
  ],
  [
    "module.network.yandex_vpc_security_group.data",
    "yandex_vpc_security_group",
    "safe-action-data-security-group",
  ],
  [
    "module.compute.data.yandex_compute_image.ubuntu_lts",
    "yandex_compute_image",
    "safe-action-ubuntu-image",
  ],
  ["module.compute.yandex_vpc_address.app", "yandex_vpc_address", "safe-action-app-address"],
  [
    "module.compute.yandex_compute_instance.app",
    "yandex_compute_instance",
    "safe-action-app-compute",
  ],
  [
    "module.postgres.yandex_mdb_postgresql_cluster.production",
    "yandex_mdb_postgresql_cluster",
    "safe-action-postgres-cluster",
  ],
  [
    "module.postgres.yandex_mdb_postgresql_database.application",
    "yandex_mdb_postgresql_database",
    "safe-action-postgres-database",
  ],
  [
    "module.object_storage.yandex_storage_bucket.media",
    "yandex_storage_bucket",
    "safe-action-media-bucket",
  ],
  [
    "module.object_storage.yandex_storage_bucket.audit",
    "yandex_storage_bucket",
    "safe-action-audit-bucket",
  ],
  [
    "module.object_storage.yandex_storage_bucket_policy.media_app",
    "yandex_storage_bucket_policy",
    "safe-action-media-policy",
  ],
  [
    "module.object_storage.yandex_storage_bucket_iam_binding.app_uploader",
    "yandex_storage_bucket_iam_binding",
    "safe-action-app-uploader-binding",
  ],
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

const publisherReference = [
  "yandex_iam_service_account.station_release_publisher.id",
  "yandex_iam_service_account.station_release_publisher",
];
const releaseBucketReference = [
  "yandex_storage_bucket.releases.bucket",
  "yandex_storage_bucket.releases",
];
const releaseBucketDomainReference = [
  "yandex_storage_bucket.releases.bucket_domain_name",
  "yandex_storage_bucket.releases",
];
// Mirrors the per-occurrence traversal list emitted by Terraform 1.15.8.
const releasePolicyReference = [
  ...releaseBucketReference,
  ...releaseBucketReference,
  ...releaseBucketReference,
  ...releaseBucketReference,
  ...releaseBucketReference,
  ...publisherReference,
  ...publisherReference,
  "var.terraform_service_account_id",
];
const originGroupReference = [
  "yandex_cdn_origin_group.releases.id",
  "yandex_cdn_origin_group.releases",
];
const cdnReference = [
  "yandex_cdn_resource.releases.provider_cname",
  "yandex_cdn_resource.releases",
];

function addExactReleaseConfiguration(plan) {
  plan.configuration = {
    root_module: {
      module_calls: {
        station_releases: {
          module: {
            resources: [
              {
                address: "yandex_iam_service_account_static_access_key.publisher",
                expressions: {
                  service_account_id: { references: publisherReference },
                },
              },
              {
                address: "yandex_storage_bucket_iam_binding.publisher_uploader",
                expressions: { members: { references: publisherReference } },
              },
              {
                address: "yandex_storage_bucket_policy.releases",
                expressions: {
                  policy: { references: releasePolicyReference },
                },
              },
              {
                address: "yandex_cdn_origin_group.releases",
                expressions: { origin: { references: releaseBucketDomainReference } },
              },
              {
                address: "yandex_cdn_resource.releases",
                expressions: { origin_group_id: { references: originGroupReference } },
              },
              {
                address: "yandex_dns_recordset.public_release",
                expressions: { data: { references: cdnReference } },
              },
            ],
          },
        },
      },
    },
  };
}

function makeProviderComputedReleaseCreate(plan) {
  addExactReleaseConfiguration(plan);
  for (const change of plan.resource_changes.filter((candidate) =>
    candidate.address.startsWith("module.station_releases."),
  )) {
    change.change.actions = ["create"];
    change.change.before = null;
  }
  const publisher = resource(
    plan,
    "module.station_releases.yandex_iam_service_account.station_release_publisher",
  );
  publisher.change.after.id = null;
  publisher.change.after_unknown = { id: true };
  const key = resource(
    plan,
    "module.station_releases.yandex_iam_service_account_static_access_key.publisher",
  );
  key.change.after.service_account_id = null;
  key.change.after_unknown = { service_account_id: true };
  const binding = resource(
    plan,
    "module.station_releases.yandex_storage_bucket_iam_binding.publisher_uploader",
  );
  binding.change.after.members = [null];
  binding.change.after_unknown = { members: [true] };
  const policy = resource(plan, "module.station_releases.yandex_storage_bucket_policy.releases");
  policy.change.after.policy = null;
  policy.change.after_unknown = { policy: true };
  const origin = resource(plan, "module.station_releases.yandex_cdn_origin_group.releases");
  origin.change.after.id = null;
  origin.change.after.origin[0].source = null;
  origin.change.after_unknown = { id: true, origin: [{ source: true }] };
  const cdn = resource(plan, "module.station_releases.yandex_cdn_resource.releases");
  cdn.change.after.origin_group_id = null;
  cdn.change.after.provider_cname = null;
  cdn.change.after_unknown = { origin_group_id: true, provider_cname: true };
  const dns = resource(plan, "module.station_releases.yandex_dns_recordset.public_release[0]");
  dns.change.after.data = null;
  dns.change.after_unknown = { data: true };
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
  assert.doesNotThrow(() => guardProductionPlan(creation));
});

test("production plan guard accepts provider-computed create edges only with exact references", async () => {
  const creation = await readFixture("safe");
  makeProviderComputedReleaseCreate(creation);
  assert.doesNotThrow(() => guardProductionPlan(creation));

  for (const mutateReferences of [
    (references) => references.pop(),
    (references) => references.push("yandex_storage_bucket.releases.bucket"),
  ]) {
    const wrongMultiplicity = copy(creation);
    const references =
      wrongMultiplicity.configuration.root_module.module_calls.station_releases.module.resources.find(
        (candidate) => candidate.address === "yandex_storage_bucket_policy.releases",
      ).expressions.policy.references;
    mutateReferences(references);
    reject(wrongMultiplicity);
  }

  const wholeBindingUnknown = copy(creation);
  const unknownBinding = resource(
    wholeBindingUnknown,
    "module.station_releases.yandex_storage_bucket_iam_binding.publisher_uploader",
  );
  unknownBinding.change.after.members = null;
  unknownBinding.change.after_unknown = { members: true };
  assert.doesNotThrow(() => guardProductionPlan(wholeBindingUnknown));

  const knownOriginWithComputedCdnEdge = await readFixture("safe");
  addExactReleaseConfiguration(knownOriginWithComputedCdnEdge);
  const computedCdn = resource(
    knownOriginWithComputedCdnEdge,
    "module.station_releases.yandex_cdn_resource.releases",
  );
  computedCdn.change.actions = ["update"];
  computedCdn.change.after.origin_group_id = null;
  computedCdn.change.after_unknown = { origin_group_id: true };
  assert.doesNotThrow(() => guardProductionPlan(knownOriginWithComputedCdnEdge));

  const knownCdnWithComputedDnsEdge = await readFixture("safe");
  addExactReleaseConfiguration(knownCdnWithComputedDnsEdge);
  const computedDns = resource(
    knownCdnWithComputedDnsEdge,
    "module.station_releases.yandex_dns_recordset.public_release[0]",
  );
  computedDns.change.actions = ["update"];
  computedDns.change.after.data = null;
  computedDns.change.after_unknown = { data: true };
  assert.doesNotThrow(() => guardProductionPlan(knownCdnWithComputedDnsEdge));

  for (const mutate of [
    (plan) => {
      delete plan.configuration;
    },
    (plan) => {
      plan.configuration.root_module.module_calls.station_releases.module.resources.find(
        (candidate) => candidate.address === "yandex_cdn_resource.releases",
      ).expressions.origin_group_id.references = [
        "yandex_cdn_origin_group.application.id",
        "yandex_cdn_origin_group.application",
      ];
    },
    (plan) => {
      plan.configuration.root_module.module_calls.station_releases.module.resources.find(
        (candidate) =>
          candidate.address === "yandex_iam_service_account_static_access_key.publisher",
      ).expressions.service_account_id.references = [
        "yandex_iam_service_account.application.id",
        "yandex_iam_service_account.application",
      ];
    },
    (plan) => {
      plan.configuration.root_module.module_calls.station_releases.module.resources
        .find((candidate) => candidate.address === "yandex_dns_recordset.public_release")
        .expressions.data.references.push("yandex_cdn_resource.application.provider_cname");
    },
    (plan) => {
      plan.configuration.root_module.module_calls.station_releases.module.resources.find(
        (candidate) => candidate.address === "yandex_storage_bucket_policy.releases",
      ).expressions.policy.references = releaseBucketReference;
    },
    (plan) => {
      plan.configuration.root_module.module_calls.station_releases.module.resources.find(
        (candidate) => candidate.address === "yandex_cdn_origin_group.releases",
      ).expressions.origin.references = [
        "yandex_storage_bucket.media.bucket_domain_name",
        "yandex_storage_bucket.media",
      ];
    },
    (plan) => {
      plan.configuration.root_module.module_calls.station_releases.module.resources
        .find((candidate) => candidate.address === "yandex_cdn_origin_group.releases")
        .expressions.origin.references.push("var.release_bucket_name");
    },
  ]) {
    const invalid = copy(creation);
    mutate(invalid);
    reject(invalid);
  }

  const sourceWithoutUnknownMarker = copy(creation);
  delete resource(
    sourceWithoutUnknownMarker,
    "module.station_releases.yandex_cdn_origin_group.releases",
  ).change.after_unknown.origin[0].source;
  reject(sourceWithoutUnknownMarker);

  const computedSourceUpdate = copy(creation);
  resource(
    computedSourceUpdate,
    "module.station_releases.yandex_cdn_origin_group.releases",
  ).change.actions = ["update"];
  reject(computedSourceUpdate);

  for (const references of [undefined, ["yandex_iam_service_account.application.id"]]) {
    const invalid = copy(wholeBindingUnknown);
    const expression =
      invalid.configuration.root_module.module_calls.station_releases.module.resources.find(
        (candidate) => candidate.address === "yandex_storage_bucket_iam_binding.publisher_uploader",
      ).expressions;
    if (references === undefined) delete expression.members;
    else expression.members.references = references;
    reject(invalid);
  }
});

test("production plan guard binds release DNS, CDN, origin, bucket, and Terraform principal", async () => {
  const safe = await readFixture("safe");
  const mutations = [
    (plan) => {
      resource(
        plan,
        "module.station_releases.yandex_dns_recordset.public_release[0]",
      ).change.after.data = ["substituted.example.net."];
    },
    (plan) => {
      plan.resource_changes.push({
        address: "yandex_dns_recordset.extra_release[0]",
        type: "yandex_dns_recordset",
        change: {
          actions: ["create"],
          before: null,
          after: { name: "releases.markiro.app.", type: "A", data: ["203.0.113.9"] },
        },
      });
    },
    (plan) => {
      resource(
        plan,
        "module.station_releases.yandex_cdn_resource.releases",
      ).change.after.origin_group_id = "application-origin-group-id";
    },
    (plan) => {
      resource(
        plan,
        "module.station_releases.yandex_cdn_origin_group.releases",
      ).change.after.origin[0].source = "application-media.storage.yandexcloud.net";
    },
    (plan) => {
      plan.resource_changes.push({
        address: "yandex_resourcemanager_folder_iam_member.app_storage_admin",
        type: "yandex_resourcemanager_folder_iam_member",
        change: {
          actions: ["create"],
          before: null,
          after: {
            folder_id: "folder-id",
            role: "storage.admin",
            member: "serviceAccount:app-runtime-sa-id",
          },
        },
      });
    },
    (plan) => {
      const policyChange = resource(
        plan,
        "module.station_releases.yandex_storage_bucket_policy.releases",
      ).change;
      const policy = JSON.parse(policyChange.after.policy);
      policy.Statement.find(
        (statement) => statement.Sid === "AllowTerraformReleaseManagement",
      ).Principal.CanonicalUser = "app-runtime-sa-id";
      policyChange.after.policy = JSON.stringify(policy);
    },
  ];
  for (const mutate of mutations) {
    const plan = copy(safe);
    mutate(plan);
    reject(plan);
  }
});

test("production plan guard fails closed for unclassified and computed security topology", async () => {
  const safe = await readFixture("safe");
  const unclassified = copy(safe);
  unclassified.resource_changes.push({
    address: "yandex_vpc_network.unreviewed",
    type: "yandex_vpc_network",
    change: { actions: ["no-op"], before: {}, after: {} },
  });
  reject(unclassified);

  for (const [address, attribute] of [
    ["module.station_releases.yandex_cdn_resource.releases", "origin_group_id"],
    ["module.station_releases.yandex_dns_recordset.public_release[0]", "data"],
  ]) {
    const unknown = copy(safe);
    resource(unknown, address).change.after[attribute] = null;
    resource(unknown, address).change.after_unknown = { [attribute]: true };
    reject(unknown);
  }

  const unknownPolicy = copy(safe);
  const policy = resource(
    unknownPolicy,
    "module.station_releases.yandex_storage_bucket_policy.releases",
  );
  policy.change.after.policy = null;
  policy.change.after_unknown = { policy: true };
  reject(unknownPolicy);
});

test("production plan guard classifies every safe production action exactly", async () => {
  const safe = await readFixture("safe");
  const unrelatedNoOp = copy(safe);
  unrelatedNoOp.resource_changes.push({
    address: "module.network.yandex_vpc_network.production",
    type: "yandex_vpc_network",
    change: { actions: ["no-op"], before: { id: "network-id" }, after: { id: "network-id" } },
  });
  assert.doesNotThrow(() => guardProductionPlan(unrelatedNoOp));

  for (const actions of [["create"], ["update"], ["delete"]]) {
    const changed = copy(unrelatedNoOp);
    const network = resource(changed, "module.network.yandex_vpc_network.production");
    network.change.actions = actions;
    if (actions[0] === "delete") network.change.after = null;
    reject(changed);
  }

  const protectedUpdate = copy(safe);
  resource(protectedUpdate, "module.compute.yandex_compute_instance.app").change.actions = [
    "update",
  ];
  reject(protectedUpdate);
});

test("guard CLI reports only a fixed rejection scope without plan values", async () => {
  const safe = await readFixture("safe");
  const protectedUpdate = copy(safe);
  resource(protectedUpdate, "module.compute.yandex_compute_instance.app").change.actions = [
    "update",
  ];
  await withPlan(protectedUpdate, (planPath) => {
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" });
      assert.fail("guard CLI unexpectedly accepted protected update");
    } catch (error) {
      stderr = String(error.stderr);
    }
    assert.equal(stderr, "production plan rejected (safe-action-app-compute)\n");
  });

  const invalidBucket = copy(safe);
  resource(
    invalidBucket,
    "module.station_releases.yandex_storage_bucket.releases",
  ).change.after.acl = "do-not-print-this-plan-value";
  await withPlan(invalidBucket, (planPath) => {
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" });
      assert.fail("guard CLI unexpectedly accepted invalid release bucket");
    } catch (error) {
      stderr = String(error.stderr);
    }
    assert.equal(stderr, "production plan rejected (release-bucket)\n");
    assert.doesNotMatch(stderr, /do-not-print-this-plan-value/);
  });
});

test("guard CLI exposes a fixed rejection scope as a GitHub annotation", async () => {
  const safe = await readFixture("safe");
  const protectedUpdate = copy(safe);
  resource(protectedUpdate, "module.compute.yandex_compute_instance.app").change.actions = [
    "update",
  ];
  resource(protectedUpdate, "module.compute.yandex_compute_instance.app").change.after.name =
    "do-not-print-this-plan-value";

  await withPlan(protectedUpdate, (planPath) => {
    let stdout = "";
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, planPath], {
        cwd: root,
        env: { ...process.env, GITHUB_ACTIONS: "true" },
        stdio: "pipe",
      });
      assert.fail("guard CLI unexpectedly accepted protected update");
    } catch (error) {
      stdout = String(error.stdout);
      stderr = String(error.stderr);
    }
    assert.equal(stdout, "::error title=Production plan rejected::safe-action-app-compute-name\n");
    assert.equal(stderr, "production plan rejected (safe-action-app-compute-name)\n");
    assert.doesNotMatch(stdout, /do-not-print-this-plan-value/);
    assert.doesNotMatch(stderr, /do-not-print-this-plan-value/);
  });
});

test("guard CLI exposes a fixed release-policy subscope without leaking plan values", async () => {
  const safe = await readFixture("safe");
  const invalidPolicy = copy(safe);
  const policyChange = resource(
    invalidPolicy,
    "module.station_releases.yandex_storage_bucket_policy.releases",
  ).change;
  const policy = JSON.parse(policyChange.after.policy);
  policy.Statement.find(
    (statement) => statement.Sid === "AllowPublisherStationObjects",
  ).Action.push("do-not-print-this-plan-value");
  policyChange.after.policy = JSON.stringify(policy);

  await withPlan(invalidPolicy, (planPath) => {
    let stdout = "";
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, planPath], {
        cwd: root,
        env: { ...process.env, GITHUB_ACTIONS: "true" },
        stdio: "pipe",
      });
      assert.fail("guard CLI unexpectedly accepted invalid release policy");
    } catch (error) {
      stdout = String(error.stdout);
      stderr = String(error.stderr);
    }
    assert.equal(
      stdout,
      "::error title=Production plan rejected::release-policy-publisher-objects-action\n",
    );
    assert.equal(stderr, "production plan rejected (release-policy-publisher-objects-action)\n");
    assert.doesNotMatch(stdout, /do-not-print-this-plan-value/);
    assert.doesNotMatch(stderr, /do-not-print-this-plan-value/);
  });
});

test("guard CLI exposes a fixed release-origin-group subscope without leaking plan values", async () => {
  const safe = await readFixture("safe");
  resource(
    safe,
    "module.station_releases.yandex_cdn_origin_group.releases",
  ).change.after.origin[0].source = "do-not-print-this-plan-value";

  await withPlan(safe, (planPath) => {
    let stdout = "";
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, planPath], {
        cwd: root,
        env: { ...process.env, GITHUB_ACTIONS: "true" },
        stdio: "pipe",
      });
      assert.fail("guard CLI unexpectedly accepted invalid release origin group");
    } catch (error) {
      stdout = String(error.stdout);
      stderr = String(error.stderr);
    }
    assert.equal(stdout, "::error title=Production plan rejected::release-origin-group-source\n");
    assert.equal(stderr, "production plan rejected (release-origin-group-source)\n");
    assert.doesNotMatch(stdout, /do-not-print-this-plan-value/);
    assert.doesNotMatch(stderr, /do-not-print-this-plan-value/);
  });
});

test("guard CLI rejects computed release origin references without leaking them", async () => {
  const cases = [
    {
      scope: "configuration",
      mutate(plan) {
        const resources =
          plan.configuration.root_module.module_calls.station_releases.module.resources;
        plan.configuration.root_module.module_calls.station_releases.module.resources =
          resources.filter((candidate) => candidate.address !== "yandex_cdn_origin_group.releases");
      },
    },
    {
      scope: "expression",
      mutate(plan) {
        delete plan.configuration.root_module.module_calls.station_releases.module.resources.find(
          (candidate) => candidate.address === "yandex_cdn_origin_group.releases",
        ).expressions.origin;
      },
    },
    {
      scope: "shape",
      mutate(plan) {
        plan.configuration.root_module.module_calls.station_releases.module.resources.find(
          (candidate) => candidate.address === "yandex_cdn_origin_group.releases",
        ).expressions.origin.do_not_print_this_plan_value = true;
      },
    },
    {
      scope: "count",
      mutate(plan) {
        plan.configuration.root_module.module_calls.station_releases.module.resources
          .find((candidate) => candidate.address === "yandex_cdn_origin_group.releases")
          .expressions.origin.references.push("do-not-print-this-plan-value");
      },
    },
    {
      scope: "values",
      mutate(plan) {
        plan.configuration.root_module.module_calls.station_releases.module.resources.find(
          (candidate) => candidate.address === "yandex_cdn_origin_group.releases",
        ).expressions.origin.references[0] = "do-not-print-this-plan-value";
      },
    },
  ];

  for (const { scope, mutate } of cases) {
    const model = await readFixture("safe");
    makeProviderComputedReleaseCreate(model);
    const computed = copy(model);
    mutate(computed);

    await withPlan(computed, (planPath) => {
      let stdout = "";
      let stderr = "";
      try {
        execFileSync(process.execPath, [script, planPath], {
          cwd: root,
          env: { ...process.env, GITHUB_ACTIONS: "true" },
          stdio: "pipe",
        });
        assert.fail("guard CLI unexpectedly accepted invalid release origin references");
      } catch (error) {
        stdout = String(error.stdout);
        stderr = String(error.stderr);
      }
      assert.equal(
        stdout,
        `::error title=Production plan rejected::release-origin-group-source-references-${scope}\n`,
      );
      assert.equal(
        stderr,
        `production plan rejected (release-origin-group-source-references-${scope})\n`,
      );
      assert.doesNotMatch(stdout, /do-not-print-this-plan-value/);
      assert.doesNotMatch(stderr, /do-not-print-this-plan-value/);
    });
  }
});

test("production plan guard distinguishes release-policy failure classes", async () => {
  const safe = await readFixture("safe");
  const cases = [
    {
      scope: "release-policy-json",
      makePlan() {
        const plan = copy(safe);
        resource(
          plan,
          "module.station_releases.yandex_storage_bucket_policy.releases",
        ).change.after.policy = "not-json";
        return plan;
      },
    },
    {
      scope: "release-policy-statement-count",
      makePlan() {
        const plan = copy(safe);
        const policyChange = resource(
          plan,
          "module.station_releases.yandex_storage_bucket_policy.releases",
        ).change;
        const policy = JSON.parse(policyChange.after.policy);
        policy.Statement.pop();
        policyChange.after.policy = JSON.stringify(policy);
        return plan;
      },
    },
    {
      scope: "release-policy-terraform-identity",
      makePlan() {
        const plan = copy(safe);
        const policyChange = resource(
          plan,
          "module.station_releases.yandex_storage_bucket_policy.releases",
        ).change;
        const policy = JSON.parse(policyChange.after.policy);
        policy.Statement.find(
          (statement) => statement.Sid === "AllowTerraformReleaseManagement",
        ).Principal.CanonicalUser = "app-runtime-sa-id";
        policyChange.after.policy = JSON.stringify(policy);
        return plan;
      },
    },
    {
      scope: "release-policy-computed-references",
      makePlan() {
        const plan = copy(safe);
        makeProviderComputedReleaseCreate(plan);
        plan.configuration.root_module.module_calls.station_releases.module.resources.find(
          (candidate) => candidate.address === "yandex_storage_bucket_policy.releases",
        ).expressions.policy.references = releaseBucketReference;
        return plan;
      },
    },
  ];

  for (const { scope, makePlan } of cases) {
    assert.throws(() => guardProductionPlan(makePlan()), {
      message: `production plan rejected (${scope})`,
    });
  }
});

test("guard CLI does not annotate unscoped errors in GitHub Actions", () => {
  let stdout = "";
  let stderr = "";
  try {
    execFileSync(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, GITHUB_ACTIONS: "true" },
      stdio: "pipe",
    });
    assert.fail("guard CLI unexpectedly accepted a missing plan path");
  } catch (error) {
    stdout = String(error.stdout);
    stderr = String(error.stderr);
  }
  assert.equal(stdout, "");
  assert.equal(stderr, "production plan rejected\n");
});

test("guard CLI identifies every fixed safe resource without plan values", async () => {
  const safe = await readFixture("safe");
  for (const [address, type, expectedScope] of fixedSafeActionScopes) {
    const changed = copy(safe);
    let changedResource = changed.resource_changes.find(
      (candidate) => candidate.address === address,
    );
    if (!changedResource) {
      changedResource = {
        address,
        type,
        change: { actions: ["update"], before: {}, after: {} },
      };
      changed.resource_changes.push(changedResource);
    } else {
      changedResource.change.actions = ["update"];
    }
    changedResource.change.after.diagnostic_value = "do-not-print-this-plan-value";

    await withPlan(changed, (planPath) => {
      let stderr = "";
      try {
        execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" });
        assert.fail(`guard CLI unexpectedly accepted ${address}`);
      } catch (error) {
        stderr = String(error.stderr);
      }
      assert.equal(stderr, `production plan rejected (${expectedScope})\n`);
      assert.doesNotMatch(stderr, /do-not-print-this-plan-value/);
    });
  }
});

test("guard CLI identifies changed VM fields without their values", async () => {
  const cases = [
    {
      before: {
        metadata: {
          "enable-oslogin": "false",
          "serial-port-enable": "false",
          "user-data": "old-cloud-init",
        },
      },
      after: {
        metadata: {
          "enable-oslogin": "false",
          "serial-port-enable": "false",
          "user-data": "do-not-print-this-plan-value",
        },
      },
      scope: "metadata-user-data",
    },
    {
      before: { labels: { environment: "old-label" } },
      after: { labels: { environment: "do-not-print-this-plan-value" } },
      scope: "labels",
    },
    {
      before: { resources: [{ cores: 2, memory: 4 }] },
      after: { resources: [{ cores: 4, memory: 4 }] },
      scope: "resources",
    },
    {
      before: { boot_disk: [{ device_name: "old-disk" }] },
      after: { boot_disk: [{ device_name: "do-not-print-this-plan-value" }] },
      scope: "boot-disk",
    },
    {
      before: { network_interface: [{ subnet_id: "old-subnet" }] },
      after: { network_interface: [{ subnet_id: "do-not-print-this-plan-value" }] },
      scope: "network-interface",
    },
    {
      before: { service_account_id: "old-service-account" },
      after: { service_account_id: "do-not-print-this-plan-value" },
      scope: "service-account",
    },
    {
      before: { platform_id: "old-platform" },
      after: { platform_id: "do-not-print-this-plan-value" },
      scope: "platform",
    },
  ];

  for (const { before, after, scope } of cases) {
    const changed = await readFixture("safe");
    const app = resource(changed, "module.compute.yandex_compute_instance.app");
    app.change.actions = ["update"];
    app.change.before = before;
    app.change.after = after;

    await withPlan(changed, (planPath) => {
      let stderr = "";
      try {
        execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" });
        assert.fail(`guard CLI unexpectedly accepted VM ${scope} update`);
      } catch (error) {
        stderr = String(error.stderr);
      }
      assert.equal(stderr, `production plan rejected (safe-action-app-compute-${scope})\n`);
      assert.doesNotMatch(stderr, /old-|do-not-print-this-plan-value/);
    });
  }
});

test("guard CLI identifies changed app security-group fields without their values", async () => {
  const cases = [
    {
      before: { ingress: [{ description: "old-ingress-rule" }] },
      after: { ingress: [{ description: "do-not-print-this-plan-value" }] },
      scope: "ingress-description",
    },
    {
      before: { ingress: [{ from_port: 8080, to_port: 8080 }] },
      after: { ingress: [{ from_port: 80, to_port: 80 }] },
      scope: "ingress-from-port-and-to-port",
    },
    {
      before: {
        ingress: [{ id: "old-rule-id", labels: { source: "old-label" }, port: 8080 }],
      },
      after: {
        ingress: [
          {
            id: "do-not-print-this-plan-value",
            labels: { source: "do-not-print-this-plan-value" },
            port: 80,
          },
        ],
      },
      scope: "ingress-id-and-labels-and-port",
    },
    {
      before: { ingress: [{ security_group_id: "old-security-group" }] },
      after: { ingress: [{ v4_cidr_blocks: ["do-not-print-this-plan-value"] }] },
      scope: "ingress-security-group-and-v4-cidrs",
    },
    {
      before: { egress: [{ description: "old-egress-rule" }] },
      after: { egress: [{ description: "do-not-print-this-plan-value" }] },
      scope: "egress",
    },
    {
      before: { labels: { environment: "old-label" } },
      after: { labels: { environment: "do-not-print-this-plan-value" } },
      scope: "labels",
    },
    {
      before: { description: "old-description" },
      after: { description: "do-not-print-this-plan-value" },
      scope: "description",
    },
  ];

  for (const { before, after, scope } of cases) {
    const changed = await readFixture("safe");
    changed.resource_changes.push({
      address: "module.network.yandex_vpc_security_group.app",
      type: "yandex_vpc_security_group",
      change: { actions: ["update"], before, after },
    });

    await withPlan(changed, (planPath) => {
      let stderr = "";
      try {
        execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" });
        assert.fail(`guard CLI unexpectedly accepted app security-group ${scope} update`);
      } catch (error) {
        stderr = String(error.stderr);
      }
      assert.equal(stderr, `production plan rejected (safe-action-app-security-group-${scope})\n`);
      assert.doesNotMatch(stderr, /old-|8080|do-not-print-this-plan-value/);
    });
  }
});

test("guard CLI identifies changed data security-group fields without their values", async () => {
  const changed = await readFixture("safe");
  changed.resource_changes.push({
    address: "module.network.yandex_vpc_security_group.data",
    type: "yandex_vpc_security_group",
    change: {
      actions: ["update"],
      before: {
        ingress: [{ id: "old-rule-id", labels: { source: "old-label" }, port: 6432 }],
      },
      after: {
        ingress: [
          {
            id: "do-not-print-this-plan-value",
            labels: { source: "do-not-print-this-plan-value" },
            port: 6433,
          },
        ],
      },
    },
  });

  await withPlan(changed, (planPath) => {
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" });
      assert.fail("guard CLI unexpectedly accepted data security-group update");
    } catch (error) {
      stderr = String(error.stderr);
    }
    assert.equal(
      stderr,
      "production plan rejected (safe-action-data-security-group-ingress-id-and-labels-and-port)\n",
    );
    assert.doesNotMatch(stderr, /old-|6432|6433|do-not-print-this-plan-value/);
  });
});

test("guard CLI identifies an unknown data security-group ingress without plan values", async () => {
  const changed = await readFixture("safe");
  changed.resource_changes.push({
    address: "module.network.yandex_vpc_security_group.data",
    type: "yandex_vpc_security_group",
    change: {
      actions: ["update"],
      before: {
        ingress: [
          {
            description: "old-description",
            security_group_id: "old-security-group",
          },
        ],
      },
      after: {
        ingress: [
          {
            description: "do-not-print-this-plan-value",
            security_group_id: "do-not-print-this-plan-value",
          },
        ],
      },
      after_unknown: { ingress: true },
    },
  });

  await withPlan(changed, (planPath) => {
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" });
      assert.fail("guard CLI unexpectedly accepted unknown data security-group ingress");
    } catch (error) {
      stderr = String(error.stderr);
    }
    assert.equal(
      stderr,
      "production plan rejected (safe-action-data-security-group-ingress-after-unknown)\n",
    );
    assert.doesNotMatch(stderr, /old-|do-not-print-this-plan-value/);
  });
});

test("guard CLI identifies nested unknown data security-group fields without plan values", async () => {
  const changed = await readFixture("safe");
  changed.resource_changes.push({
    address: "module.network.yandex_vpc_security_group.data",
    type: "yandex_vpc_security_group",
    change: {
      actions: ["update"],
      before: {
        ingress: [{ id: "old-rule-id", security_group_id: "old-security-group" }],
      },
      after: {
        ingress: [
          {
            id: "do-not-print-this-plan-value",
            security_group_id: "do-not-print-this-plan-value",
          },
        ],
      },
      after_unknown: {
        ingress: [{ id: true, labels: true, security_group_id: true }],
      },
    },
  });

  await withPlan(changed, (planPath) => {
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" });
      assert.fail("guard CLI unexpectedly accepted nested unknown security-group fields");
    } catch (error) {
      stderr = String(error.stderr);
    }
    assert.equal(
      stderr,
      "production plan rejected (safe-action-data-security-group-ingress-after-unknown-id-and-labels-and-security-group)\n",
    );
    assert.doesNotMatch(stderr, /old-|do-not-print-this-plan-value/);
  });
});

test("guard CLI identifies data security-group ingress cardinality without plan values", async () => {
  const changed = await readFixture("safe");
  const rule = (suffix) => ({
    description: `description-${suffix}`,
    from_port: suffix,
    id: `rule-${suffix}`,
    labels: { source: `label-${suffix}` },
    port: suffix,
    predefined_target: `target-${suffix}`,
    protocol: `protocol-${suffix}`,
    security_group_id: `security-group-${suffix}`,
    to_port: suffix,
    v4_cidr_blocks: [`v4-${suffix}`],
    v6_cidr_blocks: [`v6-${suffix}`],
  });
  changed.resource_changes.push({
    address: "module.network.yandex_vpc_security_group.data",
    type: "yandex_vpc_security_group",
    change: {
      actions: ["update"],
      before: { ingress: [rule(1), rule(2)] },
      after: { ingress: [rule(3)] },
    },
  });

  await withPlan(changed, (planPath) => {
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" });
      assert.fail("guard CLI unexpectedly accepted security-group ingress cardinality drift");
    } catch (error) {
      stderr = String(error.stderr);
    }
    assert.equal(
      stderr,
      "production plan rejected (safe-action-data-security-group-ingress-cardinality-before-2-after-1-desired-matches-before-0)\n",
    );
    assert.doesNotMatch(
      stderr,
      /description-[123]|rule-[123]|label-[123]|target-[123]|protocol-[123]|security-group-[123]|v4-[123]|v6-[123]/,
    );
  });
});

test("guard CLI counts semantically duplicate desired ingress rules without plan values", async () => {
  const changed = await readFixture("safe");
  const desiredRule = {
    description: "same-description",
    from_port: -1,
    id: "new-rule-id",
    labels: { source: "new-label" },
    port: 6432,
    predefined_target: "",
    protocol: "TCP",
    security_group_id: "same-security-group",
    to_port: -1,
    v4_cidr_blocks: [],
    v6_cidr_blocks: [],
  };
  const liveRule = (suffix) => ({
    ...desiredRule,
    from_port: 6432,
    id: `old-rule-${suffix}`,
    labels: { source: `old-label-${suffix}` },
    port: -1,
    protocol: "tcp",
    to_port: 6432,
  });
  changed.resource_changes.push({
    address: "module.network.yandex_vpc_security_group.data",
    type: "yandex_vpc_security_group",
    change: {
      actions: ["update"],
      before: { ingress: [liveRule(1), liveRule(2)] },
      after: { ingress: [desiredRule] },
    },
  });

  await withPlan(changed, (planPath) => {
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" });
      assert.fail("guard CLI unexpectedly accepted duplicate security-group ingress rules");
    } catch (error) {
      stderr = String(error.stderr);
    }
    assert.equal(
      stderr,
      "production plan rejected (safe-action-data-security-group-ingress-cardinality-before-2-after-1-desired-matches-before-2)\n",
    );
    assert.doesNotMatch(stderr, /same-description|same-security-group|old-rule|old-label/);
  });
});

test("guard CLI identifies only semantic fields that differ in an unmatched ingress rule", async () => {
  const changed = await readFixture("safe");
  const desiredRule = {
    description: "desired-description",
    from_port: -1,
    id: "new-rule-id",
    labels: { source: "new-label" },
    port: 6432,
    predefined_target: "",
    protocol: "TCP",
    security_group_id: "desired-security-group",
    to_port: -1,
    v4_cidr_blocks: [],
    v6_cidr_blocks: [],
  };
  const matchingLiveRule = {
    ...desiredRule,
    from_port: 6432,
    id: "matching-old-rule-id",
    labels: { source: "matching-old-label" },
    port: -1,
    protocol: "tcp",
    to_port: 6432,
  };
  const unmatchedLiveRule = {
    ...desiredRule,
    description: "unmatched-description",
    id: "unmatched-old-rule-id",
    labels: { source: "unmatched-old-label" },
    port: 6433,
    protocol: "udp",
    security_group_id: "unmatched-security-group",
    v4_cidr_blocks: ["unmatched-v4-cidr"],
  };
  changed.resource_changes.push({
    address: "module.network.yandex_vpc_security_group.data",
    type: "yandex_vpc_security_group",
    change: {
      actions: ["update"],
      before: { ingress: [matchingLiveRule, unmatchedLiveRule] },
      after: { ingress: [desiredRule] },
    },
  });

  await withPlan(changed, (planPath) => {
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" });
      assert.fail("guard CLI unexpectedly accepted an unmatched security-group ingress rule");
    } catch (error) {
      stderr = String(error.stderr);
    }
    assert.equal(
      stderr,
      "production plan rejected (safe-action-data-security-group-ingress-cardinality-before-2-after-1-desired-matches-before-1-unmatched-diff-description-and-port-range-and-protocol-and-security-group-and-v4-cidrs)\n",
    );
    assert.doesNotMatch(
      stderr,
      /desired-description|unmatched-description|matching-old|unmatched-old|desired-security-group|unmatched-security-group|643[23]|TCP|tcp|udp/,
    );
  });
});

test("guard CLI classifies an unmatched ingress source without exposing its values", async () => {
  const changed = await readFixture("safe");
  const desiredRule = {
    description: "desired-description",
    from_port: -1,
    id: "new-rule-id",
    labels: { source: "new-label" },
    port: 6432,
    predefined_target: "",
    protocol: "TCP",
    security_group_id: "desired-security-group",
    to_port: -1,
    v4_cidr_blocks: [],
    v6_cidr_blocks: [],
  };
  const matchingLiveRule = {
    ...desiredRule,
    from_port: 6432,
    id: "matching-old-rule-id",
    labels: { source: "matching-old-label" },
    port: -1,
    protocol: "tcp",
    to_port: 6432,
  };
  const unmatchedLiveRule = {
    ...desiredRule,
    description: "unmatched-description",
    id: "unmatched-old-rule-id",
    labels: { source: "unmatched-old-label" },
    security_group_id: "",
    v4_cidr_blocks: ["0.0.0.0/0", "10.20.0.0/16", "203.0.113.0/24"],
  };
  changed.resource_changes.push({
    address: "module.network.yandex_vpc_security_group.data",
    type: "yandex_vpc_security_group",
    change: {
      actions: ["update"],
      before: { ingress: [matchingLiveRule, unmatchedLiveRule] },
      after: { ingress: [desiredRule] },
    },
  });

  await withPlan(changed, (planPath) => {
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, planPath], { cwd: root, stdio: "pipe" });
      assert.fail("guard CLI unexpectedly accepted an unmatched security-group ingress source");
    } catch (error) {
      stderr = String(error.stderr);
    }
    assert.equal(
      stderr,
      "production plan rejected (safe-action-data-security-group-ingress-cardinality-before-2-after-1-desired-matches-before-1-unmatched-diff-description-and-security-group-and-v4-cidrs-unmatched-source-security-group-empty-v4-cidrs-count-3-v4-scopes-other-and-private-and-world)\n",
    );
    assert.doesNotMatch(
      stderr,
      /desired-description|unmatched-description|matching-old|unmatched-old|desired-security-group|0\.0\.0\.0|10\.20\.0\.0|203\.0\.113\.0|6432|TCP|tcp/,
    );
  });
});

function addApprovedExternalDataIngressRemoval(plan) {
  const desiredRule = {
    description: "Only the application may reach the PostgreSQL pooler.",
    from_port: -1,
    id: "desired-rule-id",
    labels: {},
    port: 6432,
    predefined_target: "",
    protocol: "TCP",
    security_group_id: "app-security-group-id",
    to_port: -1,
    v4_cidr_blocks: [],
    v6_cidr_blocks: [],
  };
  const externalRule = {
    ...desiredRule,
    description: "manual-external-access",
    id: "external-rule-id",
    security_group_id: "",
    v4_cidr_blocks: ["203.0.113.42/32"],
  };
  plan.resource_changes.push(
    {
      address: "module.network.yandex_vpc_security_group.app",
      type: "yandex_vpc_security_group",
      change: {
        actions: ["no-op"],
        before: { id: "app-security-group-id" },
        after: { id: "app-security-group-id" },
      },
    },
    {
      address: "module.network.yandex_vpc_security_group.data",
      type: "yandex_vpc_security_group",
      change: {
        actions: ["update"],
        before: {
          egress: [{ protocol: "ANY" }],
          ingress: [structuredClone(desiredRule), externalRule],
        },
        after: { egress: [{ protocol: "ANY" }], ingress: [desiredRule] },
        after_unknown: {},
      },
    },
  );
}

test("production plan guard permits only the confirmed external data ingress removal", async () => {
  const plan = await readFixture("safe");
  addApprovedExternalDataIngressRemoval(plan);
  assert.doesNotThrow(() => guardProductionPlan(plan));
});

test("production plan guard rejects broader variants of the external data ingress removal", async () => {
  const mutations = [
    (plan) => {
      resource(plan, "module.network.yandex_vpc_security_group.data").change.after.egress = [];
    },
    (plan) => {
      resource(plan, "module.network.yandex_vpc_security_group.data").change.after.ingress[0].port =
        6433;
    },
    (plan) => {
      resource(
        plan,
        "module.network.yandex_vpc_security_group.data",
      ).change.before.ingress[1].protocol = "UDP";
    },
    (plan) => {
      resource(
        plan,
        "module.network.yandex_vpc_security_group.data",
      ).change.before.ingress[1].security_group_id = "other-security-group-id";
    },
    (plan) => {
      resource(
        plan,
        "module.network.yandex_vpc_security_group.data",
      ).change.before.ingress[1].v4_cidr_blocks = ["10.20.0.0/16"];
    },
    (plan) => {
      resource(
        plan,
        "module.network.yandex_vpc_security_group.data",
      ).change.before.ingress[1].v4_cidr_blocks = ["0.0.0.0/0"];
    },
    (plan) => {
      resource(
        plan,
        "module.network.yandex_vpc_security_group.data",
      ).change.before.ingress[1].unexpected = "new-provider-field";
    },
    (plan) => {
      resource(
        plan,
        "module.network.yandex_vpc_security_group.data",
      ).change.before.ingress[0].unexpected = "new-provider-field";
    },
    (plan) => {
      resource(
        plan,
        "module.network.yandex_vpc_security_group.data",
      ).change.after.ingress[0].security_group_id = "literal-or-wrong-security-group-id";
    },
    (plan) => {
      resource(plan, "module.network.yandex_vpc_security_group.data").change.after_unknown = {
        ingress: true,
      };
    },
  ];

  for (const mutate of mutations) {
    const plan = await readFixture("safe");
    addApprovedExternalDataIngressRemoval(plan);
    mutate(plan);
    reject(plan);
  }
});

test("production plan guard permits direct-VM DNS flag enable and disable transitions", async () => {
  const safe = await readFixture("safe");
  for (const address of directVmDnsAddresses) {
    for (const actions of [["create"], ["delete"]]) {
      const dns = copy(safe);
      dns.resource_changes.push({
        address,
        type: "yandex_dns_recordset",
        change: {
          actions,
          before: actions[0] === "create" ? null : { name: "admin.markiro.app.", type: "A" },
          after: actions[0] === "delete" ? null : { name: "admin.markiro.app.", type: "A" },
        },
      });
      assert.doesNotThrow(() => guardProductionPlan(dns));
    }
  }
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
