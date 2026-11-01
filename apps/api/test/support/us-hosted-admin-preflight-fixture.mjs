import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { constants } from "node:fs";
import { resolve, basename, dirname, relative, sep } from "node:path";
import { execFile } from "node:child_process";
import {
  randomUUID,
  randomBytes,
  X509Certificate,
  createPrivateKey,
  createHash,
} from "node:crypto";
import {
  open,
  readlink,
  mkdir,
  lstat,
  realpath,
  writeFile,
  readFile,
  readdir,
  chmod,
  unlink,
  rmdir,
} from "node:fs/promises";

// Test-only fixed profiles and resource contracts. They never register production authority.
const invalid = () => new Error("us_hosted_admin_fixture_invalid");
const names = [
  "migrate",
  "seed",
  "provision",
  "wrongCA",
  "wrongName",
  "plaintext",
  "wrongDatabase",
  "wrongUser",
  "badMode",
  "badCA",
  "oversizedSecret",
  "symlinkSecret",
];
export const administrativePreflightProfiles = Object.freeze(
  names.map((name, index) =>
    Object.freeze({
      name,
      operation: name === "seed" || name === "provision" ? name : "migrate",
      server: index < 8,
      databaseHost: "postgres.us-demo.internal",
      databaseName: "markiro_us_synthetic",
      databaseUser: "markiro_us",
    }),
  ),
);
export function parseAdministrativePreflightProfile(value) {
  if (typeof value !== "string") throw invalid();
  const result = administrativePreflightProfiles.find((profile) => profile.name === value);
  if (!result) throw invalid();
  return result;
}
export function assertAdministrativeFixtureOwner(record, observedOwner) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "containerId") ||
    !Object.hasOwn(record, "owner") ||
    typeof record.containerId !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.containerId) ||
    typeof record.owner !== "string" ||
    !/^us-admin-preflight-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.owner) ||
    observedOwner !== record.owner
  )
    throw invalid();
}
export function assertAdministrativeHolderSettled(output) {
  const fail = () => new Error("us_hosted_admin_actual_child_settlement_pending");
  if (typeof output !== "string") throw fail();
  const rows = output
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/));
  if (
    rows.some((row) => row.length !== 2 || !/^[1-9][0-9]*$/.test(row[0])) ||
    new Set(rows.map((row) => row[0])).size !== rows.length ||
    rows.length !== 1 ||
    rows[0][0] !== "1" ||
    !["MainThread", "node"].includes(rows[0][1])
  )
    throw fail();
}

/** Unverified test metadata only; native preparation separately checks actual package bytes. */
export function parseAdministrativePackageLocator(document, root) {
  try {
    if (
      typeof document !== "string" ||
      Buffer.byteLength(document, "utf8") > 16384 ||
      Buffer.from(document, "utf8").toString("utf8") !== document ||
      typeof root !== "string" ||
      resolve(root) !== root
    )
      throw invalid();
    const value = JSON.parse(document);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.schemaVersion !== 1 ||
      value.purpose !== "synthetic-test-only"
    )
      throw invalid();
    const keys = [
      "schemaVersion",
      "purpose",
      "baseSha",
      "patchSha256",
      "fixtureSha",
      "source",
      "manifestSha256",
      "adminManifestSha256",
    ];
    if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
      throw invalid();
    for (const key of [
      "baseSha",
      "fixtureSha",
      "patchSha256",
      "manifestSha256",
      "adminManifestSha256",
    ]) {
      const length = key === "baseSha" || key === "fixtureSha" ? 40 : 64;
      if (
        typeof value[key] !== "string" ||
        value[key].length !== length ||
        !/^[a-f0-9]+$/.test(value[key])
      )
        throw invalid();
    }
    const prefix =
      resolve(root, ".superpowers/sdd/2026-10-22-us-11-demo-viewer/installed-fixtures") + sep;
    if (
      typeof value.source !== "string" ||
      resolve(value.source) !== value.source ||
      !value.source.startsWith(prefix) ||
      basename(value.source) !== "source" ||
      /[\p{Cc}]/u.test(value.source) ||
      Buffer.from(value.source, "utf8").toString("utf8") !== value.source
    )
      throw invalid();
    return Object.freeze(value);
  } catch {
    throw invalid();
  }
}

/** Inspection runs inside the holder PID namespace; Docker top uses host PIDs. */
export const administrativeHolderProcessProgram = `
const fs = require('node:fs');
const rows = fs.readdirSync('/proc').filter(name => /^[1-9][0-9]*$/.test(name) && Number(name) !== process.pid)
  .map(name => [name, fs.readFileSync('/proc/' + name + '/comm', 'utf8').trim()]);
process.stdout.write('PID COMMAND\\n' + rows.map(row => row.join(' ')).join('\\n') + '\\n');
`;

// command is a test-fixture orchestration dependency, never production authority.
export async function closeAdministrativeHolder(record, command) {
  assertAdministrativeFixtureOwner(record, record?.owner);
  if (typeof command !== "function") throw invalid();
  const identity = Object.freeze({ containerId: record.containerId, owner: record.owner });
  const id = identity.containerId;
  const assertOwner = async () =>
    assertAdministrativeFixtureOwner(
      identity,
      (
        await command(["inspect", "--format", '{{index .Config.Labels "us-fixture-owner"}}', id])
      ).trim(),
    );
  await assertOwner();
  assertAdministrativeHolderSettled(
    await command([
      "exec",
      "--user",
      "10001:10001",
      id,
      "node",
      "-e",
      administrativeHolderProcessProgram,
    ]),
  );
  await assertOwner();
  await command(["stop", "--time", "2", id]);
  if ((await command(["inspect", "--format", "{{.State.ExitCode}}", id])).trim() !== "0")
    throw invalid();
  await assertOwner();
  await command(["rm", id]);
  if (
    (
      await command([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        "id=" + id,
        "--format",
        "{{.ID}}",
      ])
    ).trim() !== ""
  )
    throw invalid();
  return Object.freeze({ containerId: id, owner: identity.owner, absent: true });
}

/** Only local Docker client settlement; remote processes require namespace inspection. */
export function createAdministrativeDockerClient(execute = execFile) {
  const active = new Set();
  async function run(args, input, timeoutLimit) {
    if (
      !Array.isArray(args) ||
      args.length < 1 ||
      args.length > 128 ||
      args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      Buffer.byteLength(args.join(" ")) > 32768 ||
      (input !== undefined && (!Buffer.isBuffer(input) || input.length > 16384))
    )
      throw invalid();
    const cap = args[0] === "cp" ? 90000 : 30000;
    if (
      timeoutLimit !== undefined &&
      (!Number.isFinite(timeoutLimit) || timeoutLimit <= 0 || timeoutLimit > cap)
    )
      throw invalid();
    const ownedInput = input === undefined ? undefined : Buffer.from(input);
    const operation = new Promise((resolve, reject) => {
      let stdinFailed = false;
      try {
        const child = execute(
          "docker",
          [...args],
          {
            encoding: "utf8",
            timeout: timeoutLimit === undefined ? cap : Math.max(1, Math.floor(timeoutLimit)),
            maxBuffer: 1048576,
            killSignal: "SIGTERM",
            shell: false,
          },
          (error, stdout) => {
            ownedInput?.fill(0);
            if (error || stdinFailed) reject(new Error("us_hosted_admin_docker_failed"));
            else resolve(stdout);
          },
        );
        try {
          if (ownedInput !== undefined && !child.stdin) stdinFailed = true;
          child.stdin?.on("error", () => {
            stdinFailed = true;
          });
          child.stdin?.end(ownedInput);
        } catch {
          // A launched client still owns work: only its completion callback settles it.
          stdinFailed = true;
        }
      } catch {
        ownedInput?.fill(0);
        reject(new Error("us_hosted_admin_docker_failed"));
      }
    });
    active.add(operation);
    void operation.then(
      () => active.delete(operation),
      () => active.delete(operation),
    );
    return operation;
  }
  return Object.freeze({
    run,
    settle: async () => {
      await Promise.allSettled([...active]);
    },
  });
}

function namedAdministrativeResource(record, kind) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "name") ||
    !Object.hasOwn(record, "owner") ||
    typeof record.owner !== "string" ||
    !/^us-admin-preflight-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.owner)
  )
    throw invalid();
  const suffixes = kind === "volume" ? ["app", "secrets", "server"] : ["network"];
  if (!suffixes.some((suffix) => record.name === record.owner + "-" + suffix)) throw invalid();
  return Object.freeze({ name: record.name, owner: record.owner });
}

async function closeAdministrativeNamedResource(kind, record, command) {
  const identity = namedAdministrativeResource(record, kind);
  if (typeof command !== "function") throw invalid();
  const assertOwner = async () => {
    const observed = (
      await command([
        kind,
        "inspect",
        "--format",
        '{{index .Labels "us-fixture-owner"}}',
        identity.name,
      ])
    ).trim();
    if (observed !== identity.owner) throw invalid();
  };
  await assertOwner();
  if (kind === "volume") {
    if (
      (
        await command([
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--filter",
          "volume=" + identity.name,
          "--format",
          "{{.ID}}",
        ])
      ).trim() !== ""
    )
      throw invalid();
  } else {
    const members = JSON.parse(
      await command(["network", "inspect", "--format", "{{json .Containers}}", identity.name]),
    );
    if (
      !members ||
      typeof members !== "object" ||
      Array.isArray(members) ||
      Object.keys(members).length !== 0
    )
      throw invalid();
    if (
      (await command(["network", "inspect", "--format", "{{.Internal}}", identity.name])).trim() !==
      "true"
    )
      throw invalid();
  }
  await assertOwner();
  await command([kind, "rm", identity.name]);
  if (
    (
      await command([
        kind,
        "ls",
        "--filter",
        "name=^" + identity.name + "$",
        "--format",
        "{{.Name}}",
      ])
    ).trim() !== ""
  )
    throw invalid();
  return Object.freeze({ ...identity, absent: true });
}

export async function closeAdministrativeVolume(record, command) {
  return closeAdministrativeNamedResource("volume", record, command);
}
export async function closeAdministrativeNetwork(record, command) {
  return closeAdministrativeNamedResource("network", record, command);
}

/** Fresh finite fixture acquisition. Never resumes, adopts, or cleans up after a failure. */
export async function acquireAdministrativeFixtureResources(profileName, command, persist) {
  const profile = parseAdministrativePreflightProfile(profileName);
  if (typeof command !== "function" || typeof persist !== "function") throw invalid();
  const owner = "us-admin-preflight-" + randomUUID();
  const volumes = [];
  let network = null;
  const snapshot = (phase) =>
    Object.freeze({
      phase,
      profile: profile.name,
      owner,
      volumes: Object.freeze([...volumes]),
      network,
    });
  await persist(snapshot("initial"));
  for (const suffix of profile.server ? ["app", "secrets", "server"] : ["app", "secrets"]) {
    const resource = Object.freeze({ name: owner + "-" + suffix, owner });
    volumes.push(Object.freeze({ ...resource, created: false }));
    if (
      (
        await command([
          "volume",
          "ls",
          "--filter",
          "name=^" + resource.name + "$",
          "--format",
          "{{.Name}}",
        ])
      ).trim() !== ""
    )
      throw invalid();
    await persist(snapshot("volume_create_intent"));
    if (
      (
        await command(["volume", "create", "--label", "us-fixture-owner=" + owner, resource.name])
      ).trim() !== resource.name
    )
      throw invalid();
    volumes[volumes.length - 1] = Object.freeze({ ...resource, created: true });
    await persist(snapshot("volume_created"));
    if (
      (
        await command([
          "volume",
          "inspect",
          "--format",
          '{{index .Labels "us-fixture-owner"}}',
          resource.name,
        ])
      ).trim() !== owner
    )
      throw invalid();
  }
  if (profile.server) {
    const resource = Object.freeze({ name: owner + "-network", owner });
    network = Object.freeze({ ...resource, created: false });
    if (
      (
        await command([
          "network",
          "ls",
          "--filter",
          "name=^" + resource.name + "$",
          "--format",
          "{{.Name}}",
        ])
      ).trim() !== ""
    )
      throw invalid();
    await persist(snapshot("network_create_intent"));
    const id = (
      await command([
        "network",
        "create",
        "--internal",
        "--driver",
        "bridge",
        "--label",
        "us-fixture-owner=" + owner,
        resource.name,
      ])
    ).trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw invalid();
    network = Object.freeze({ ...resource, created: true, id });
    await persist(snapshot("network_created"));
    if (
      (
        await command([
          "network",
          "inspect",
          "--format",
          '{{index .Labels "us-fixture-owner"}}',
          resource.name,
        ])
      ).trim() !== owner ||
      (await command(["network", "inspect", "--format", "{{.Internal}}", resource.name])).trim() !==
        "true" ||
      (await command(["network", "inspect", "--format", "{{.Id}}", resource.name])).trim() !== id
    )
      throw invalid();
  }
  const result = snapshot("resources_created");
  await persist(result);
  return result;
}

export const administrativeNodeImage =
  "sha256:9be410e06dadc1794f44aa4c0fd107a7ecb2edb5cb6bcc6a71c7888caf3cfa12";
export const administrativePostgresImage =
  "sha256:ff80089083d7365046af7f03d949a2defa14e0b09e14bd5b8f08a242291be8b2";

function administrativeResourceIdentity(resources) {
  if (
    !resources ||
    typeof resources !== "object" ||
    Array.isArray(resources) ||
    resources.phase !== "resources_created"
  )
    throw invalid();
  const profile = parseAdministrativePreflightProfile(resources.profile);
  const owner = resources.owner;
  if (!Array.isArray(resources.volumes)) throw invalid();
  const suffixes = profile.server ? ["app", "secrets", "server"] : ["app", "secrets"];
  if (resources.volumes.length !== suffixes.length) throw invalid();
  const volumes = resources.volumes.map((value, index) => {
    const record = namedAdministrativeResource({ name: value.name, owner: value.owner }, "volume");
    if (
      record.owner !== owner ||
      record.name !== owner + "-" + suffixes[index] ||
      value.created !== true
    )
      throw invalid();
    return record;
  });
  let network = null;
  if (profile.server) {
    const value = resources.network;
    if (
      !value ||
      value.created !== true ||
      typeof value.id !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.id)
    )
      throw invalid();
    network = Object.freeze({
      ...namedAdministrativeResource({ name: value.name, owner: value.owner }, "network"),
      id: value.id,
    });
    if (network.owner !== owner) throw invalid();
  } else if (resources.network !== null) throw invalid();
  return Object.freeze({ profile, owner, volumes: Object.freeze(volumes), network });
}

/** Creates one owned holder; package verification and preparation are separate mandatory steps. */
export async function createAdministrativeHolder(resources, phase, command, persist) {
  const identity = administrativeResourceIdentity(resources);
  if (
    !["prepare", "holder"].includes(phase) ||
    typeof command !== "function" ||
    typeof persist !== "function"
  )
    throw invalid();
  for (const volume of identity.volumes) {
    if (
      (
        await command([
          "volume",
          "inspect",
          "--format",
          '{{index .Labels "us-fixture-owner"}}',
          volume.name,
        ])
      ).trim() !== identity.owner
    )
      throw invalid();
  }
  if (identity.network) {
    if (
      (
        await command([
          "network",
          "inspect",
          "--format",
          '{{index .Labels "us-fixture-owner"}}',
          identity.network.name,
        ])
      ).trim() !== identity.owner ||
      (
        await command(["network", "inspect", "--format", "{{.Internal}}", identity.network.name])
      ).trim() !== "true" ||
      (
        await command(["network", "inspect", "--format", "{{.Id}}", identity.network.name])
      ).trim() !== identity.network.id
    )
      throw invalid();
  }
  const prepare = phase === "prepare";
  const args = [
    "create",
    "--pull=never",
    "--name",
    identity.owner + (prepare ? "-prepare" : "-holder"),
    "--label",
    "us-fixture-owner=" + identity.owner,
    "--read-only",
    "--user",
    prepare ? "0:0" : "10001:10001",
  ];
  if (prepare || !identity.network) args.push("--network=none");
  else args.push("--network", identity.network.name);
  if (!prepare) args.push("--cap-drop=ALL", "--security-opt=no-new-privileges");
  for (const [index, volume] of identity.volumes.entries()) {
    if (index === 2 && !prepare) continue;
    const destination =
      index === 0 ? "/app" : index === 1 ? "/run/secrets/us-demo" : "/fixture-server";
    args.push(
      "--mount",
      "type=volume,src=" + volume.name + ",dst=" + destination + (prepare ? "" : ",readonly"),
    );
  }
  args.push(
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,mode=0700",
    administrativeNodeImage,
    "node",
    "-e",
    "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)",
  );
  await persist(
    Object.freeze({
      phase: "holder_create_intent",
      profile: identity.profile.name,
      owner: identity.owner,
      holderPhase: phase,
    }),
  );
  const containerId = (await command(args)).trim();
  const holder = Object.freeze({ containerId, owner: identity.owner });
  assertAdministrativeFixtureOwner(holder, identity.owner);
  await persist(
    Object.freeze({
      phase: "holder_created",
      profile: identity.profile.name,
      holderPhase: phase,
      holder,
    }),
  );
  await command(["start", containerId]);
  assertAdministrativeFixtureOwner(
    holder,
    (
      await command([
        "inspect",
        "--format",
        '{{index .Config.Labels "us-fixture-owner"}}',
        containerId,
      ])
    ).trim(),
  );
  const expected = prepare ? "true 0:0 true" : "true 10001:10001 true";
  if (
    (
      await command([
        "inspect",
        "--format",
        "{{.State.Running}} {{.Config.User}} {{.HostConfig.ReadonlyRootfs}}",
        containerId,
      ])
    ).trim() !== expected
  )
    throw invalid();
  let mounts;
  try {
    mounts = JSON.parse(await command(["inspect", "--format", "{{json .Mounts}}", containerId]));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(mounts)) throw invalid();
  const volumes = mounts.filter((mount) => mount && mount.Type === "volume");
  const expectedVolumes = identity.volumes.filter((_volume, index) => prepare || index !== 2);
  if (
    volumes.length !== expectedVolumes.length ||
    mounts.some(
      (mount) =>
        !mount ||
        (mount.Type !== "volume" &&
          !(mount.Type === "tmpfs" && mount.Destination === "/tmp" && mount.RW === true)),
    )
  )
    throw invalid();
  for (const [index, volume] of expectedVolumes.entries()) {
    const destination =
      index === 0 ? "/app" : index === 1 ? "/run/secrets/us-demo" : "/fixture-server";
    if (
      volumes.filter(
        (mount) =>
          mount.Name === volume.name && mount.Destination === destination && mount.RW === prepare,
      ).length !== 1
    )
      throw invalid();
  }
  await persist(
    Object.freeze({
      phase: "holder_started",
      profile: identity.profile.name,
      holderPhase: phase,
      holder,
    }),
  );
  return holder;
}

export function administrativeConfiguration(locator, profileName) {
  const profile = parseAdministrativePreflightProfile(profileName);
  for (const key of ["fixtureSha", "manifestSha256", "adminManifestSha256"]) {
    if (
      !locator ||
      typeof locator[key] !== "string" ||
      locator[key].length !== (key === "fixtureSha" ? 40 : 64) ||
      !/^[a-f0-9]+$/.test(locator[key])
    )
      throw invalid();
  }
  const config = {
    schemaVersion: 1,
    edition: "US",
    purpose: "synthetic-demo",
    mode: "production",
    service: "admin",
    operation: profile.operation,
    release: Object.freeze({
      sourceSha: locator.fixtureSha,
      manifestSha256: locator.manifestSha256,
      adminManifestSha256: locator.adminManifestSha256,
    }),
    database: Object.freeze({
      host: "postgres.us-demo.internal",
      port: 5432,
      name: "markiro_us_synthetic",
      user: "markiro_us",
      caFile: "/run/secrets/us-demo/db-ca.pem",
      passwordFile: "/run/secrets/us-demo/admin-" + profile.operation + "-db-password",
    }),
  };
  if (profile.operation === "seed")
    config.storage = Object.freeze({
      endpoint: "https://objects.us-demo.internal",
      bucket: "markiro-us-synthetic-private",
      signingRegion: "us-east-1",
      caFile: "/run/secrets/us-demo/storage-ca.pem",
      accessKeyFile: "/run/secrets/us-demo/admin-seed-storage-access-key",
      secretKeyFile: "/run/secrets/us-demo/admin-seed-storage-secret-key",
      forcePathStyle: true,
    });
  return Object.freeze(config);
}

/** Root-only preparer. All invocation material arrives through bounded protected stdin. */
export const administrativePreparationProgram = `
const fs = require('node:fs');
const fail = () => { throw Error('us_hosted_admin_preparation_failed'); };
if (process.getuid() !== 0) fail();
const x = JSON.parse(fs.readFileSync(0, 'utf8'));
const serverProfiles = ['migrate','seed','provision','wrongCA','wrongName','plaintext','wrongDatabase','wrongUser'];
if (![...serverProfiles,'badMode','badCA','oversizedSecret','symlinkSecret'].includes(x.profile)) fail();
const operation = x.profile === 'seed' || x.profile === 'provision' ? x.profile : 'migrate';
if (!x.config || x.config.service !== 'admin' || x.config.operation !== operation) fail();
for (const key of ['dbPassword','dbCA','storageAccess','storageSecret','storageCA','serverCertificate','serverKey']) {
  if (typeof x[key] !== 'string' || !x[key] || Buffer.byteLength(x[key]) > 65536) fail();
}
const directory = path => { fs.mkdirSync(path, {recursive:true}); fs.chownSync(path,0,0); fs.chmodSync(path,0o755); };
const file = (path,bytes,mode,uid=0,gid=10001) => { fs.writeFileSync(path,bytes,{flag:'wx',mode}); fs.chownSync(path,uid,gid); fs.chmodSync(path,mode); };
directory('/run/secrets/us-demo');
const base='/run/secrets/us-demo/';
file(base+'db-ca.pem', x.profile==='badCA'?'invalid-ca':x.dbCA, 0o444);
const password=base+'admin-'+operation+'-db-password';
if(x.profile==='symlinkSecret') {
  file(base+'synthetic-target',x.dbPassword,0o440);
  fs.symlinkSync(base+'synthetic-target',password); fs.lchownSync(password,0,10001);
} else file(password,x.profile==='oversizedSecret'?Buffer.alloc(4097,120):x.dbPassword,x.profile==='badMode'?0o444:0o440);
if(operation==='seed') {
  file(base+'storage-ca.pem',x.storageCA,0o444);
  file(base+'admin-seed-storage-access-key',x.storageAccess,0o440);
  file(base+'admin-seed-storage-secret-key',x.storageSecret,0o440);
}
if(serverProfiles.includes(x.profile)) {
  directory('/fixture-server');
  file('/fixture-server/server.crt',x.serverCertificate,0o444,0,0);
  file('/fixture-server/server.key',x.serverKey,0o600,70,70);
  file('/fixture-server/db-password',x.dbPassword,0o400,70,70);
}
fs.writeFileSync('/app/us-synthetic-admin.json',JSON.stringify(x.config)+'\\n',{flag:'wx',mode:0o444});
function protect(path) {
  const stat=fs.lstatSync(path);
  if(stat.isSymbolicLink()) {fs.lchownSync(path,0,0);return;}
  if(stat.isDirectory()) {for(const name of fs.readdirSync(path))protect(path+'/'+name);fs.chownSync(path,0,0);fs.chmodSync(path,0o555);}
  else if(stat.isFile()) {fs.chownSync(path,0,0);fs.chmodSync(path,0o444);}
  else fail();
}
protect('/app');
process.stdout.write('[1]\\n');
`;

/** Starts only the isolated fixture server. Readiness and quiescent close remain separate gates. */
export async function createAdministrativePostgres(resources, command, persist) {
  const identity = administrativeResourceIdentity(resources);
  if (
    !identity.profile.server ||
    !identity.network ||
    typeof command !== "function" ||
    typeof persist !== "function"
  )
    throw invalid();
  const volume = identity.volumes[2];
  if (
    (
      await command([
        "volume",
        "inspect",
        "--format",
        '{{index .Labels "us-fixture-owner"}}',
        volume.name,
      ])
    ).trim() !== identity.owner ||
    (
      await command([
        "network",
        "inspect",
        "--format",
        '{{index .Labels "us-fixture-owner"}}',
        identity.network.name,
      ])
    ).trim() !== identity.owner ||
    (await command(["network", "inspect", "--format", "{{.Id}}", identity.network.name])).trim() !==
      identity.network.id ||
    (
      await command(["network", "inspect", "--format", "{{.Internal}}", identity.network.name])
    ).trim() !== "true"
  )
    throw invalid();
  const args = [
    "create",
    "--pull=never",
    "--name",
    identity.owner + "-postgres",
    "--label",
    "us-fixture-owner=" + identity.owner,
    "--network",
    identity.network.name,
    "--network-alias",
    "postgres.us-demo.internal",
    "--read-only",
    "--user",
    "0:0",
    "--cap-drop=ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--security-opt=no-new-privileges",
    "--mount",
    "type=volume,src=" + volume.name + ",dst=/run/us-demo-server,readonly",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,nosuid,nodev,noexec,mode=0700",
    "--tmpfs",
    "/var/run/postgresql:rw,nosuid,nodev,noexec,mode=0775",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,mode=0700",
    "--env",
    "PGDATA=/var/lib/postgresql/data",
    "--env",
    "POSTGRES_USER=" + (identity.profile.name === "wrongUser" ? "markiro_other" : "markiro_us"),
    "--env",
    "POSTGRES_DB=" +
      (identity.profile.name === "wrongDatabase" ? "markiro_other" : "markiro_us_synthetic"),
    "--env",
    "POSTGRES_PASSWORD_FILE=/run/us-demo-server/db-password",
    administrativePostgresImage,
    "sh",
    "-ec",
    'test "$(id -u postgres)" = 70 && test "$(id -g postgres)" = 70 && test "$(stat -c %u:%g:%a /run/us-demo-server/server.key)" = 70:70:600 && chmod 0700 /var/lib/postgresql/data /tmp && chmod 0775 /var/run/postgresql && chown 70:70 /var/lib/postgresql/data /var/run/postgresql /tmp && exec gosu postgres:postgres docker-entrypoint.sh "$@"',
    "us-admin-pg",
    "postgres",
    "-c",
    "ssl=" + (identity.profile.name === "plaintext" ? "off" : "on"),
    "-c",
    "ssl_cert_file=/run/us-demo-server/server.crt",
    "-c",
    "ssl_key_file=/run/us-demo-server/server.key",
    "-c",
    "listen_addresses=*",
    "-c",
    "log_statement=none",
  ];
  await persist(
    Object.freeze({
      phase: "postgres_create_intent",
      profile: identity.profile.name,
      owner: identity.owner,
    }),
  );
  const holder = Object.freeze({
    containerId: (await command(args)).trim(),
    owner: identity.owner,
  });
  assertAdministrativeFixtureOwner(holder, identity.owner);
  await persist(
    Object.freeze({ phase: "postgres_created", profile: identity.profile.name, holder }),
  );
  assertAdministrativeFixtureOwner(
    holder,
    (
      await command([
        "inspect",
        "--format",
        '{{index .Config.Labels "us-fixture-owner"}}',
        holder.containerId,
      ])
    ).trim(),
  );
  if (
    (
      await command([
        "inspect",
        "--format",
        "{{.Config.User}} {{.HostConfig.ReadonlyRootfs}}",
        holder.containerId,
      ])
    ).trim() !== "0:0 true"
  )
    throw invalid();
  let mounts, bindings;
  try {
    mounts = JSON.parse(
      await command(["inspect", "--format", "{{json .Mounts}}", holder.containerId]),
    );
    bindings = JSON.parse(
      await command([
        "inspect",
        "--format",
        "{{json .HostConfig.PortBindings}}",
        holder.containerId,
      ]),
    );
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(mounts) ||
    mounts.filter(
      (mount) =>
        mount &&
        mount.Type === "volume" &&
        mount.Name === volume.name &&
        mount.Destination === "/run/us-demo-server" &&
        mount.RW === false,
    ).length !== 1 ||
    mounts.some(
      (mount) =>
        !mount ||
        (mount.Type === "volume"
          ? mount.Name !== volume.name
          : mount.Type !== "tmpfs" ||
            !["/tmp", "/var/lib/postgresql/data", "/var/run/postgresql"].includes(
              mount.Destination,
            )),
    ) ||
    (bindings !== null &&
      (typeof bindings !== "object" ||
        Array.isArray(bindings) ||
        Object.keys(bindings).length !== 0))
  )
    throw invalid();
  assertAdministrativePostgresNetwork(
    await command([
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      holder.containerId,
    ]),
    identity.network,
    false,
  );
  await command(["start", holder.containerId]);
  assertAdministrativePostgresNetwork(
    await command([
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      holder.containerId,
    ]),
    identity.network,
    true,
  );
  await persist(
    Object.freeze({ phase: "postgres_started", profile: identity.profile.name, holder }),
  );
  return holder;
}

export const administrativePostgresCredentialAwk = String.raw`
/^Uid:/ { if(NF!=5 || $2!=70 || $3!=70 || $4!=70 || $5!=70)exit 1; uid=1 }
/^Gid:/ { if(NF!=5 || $2!=70 || $3!=70 || $4!=70 || $5!=70)exit 1; gid=1 }
/^CapEff:/ { if($2 !~ /^0+$/)exit 1; cap=1 }
/^NoNewPrivs:/ { if($2!=1)exit 1; nnp=1 }
END { if(uid!=1 || gid!=1 || cap!=1 || nnp!=1)exit 1 }
`;
export const administrativePostgresReadyProgram = `
set -eu
IFS= read -r main_name < /proc/1/comm
if [ "$main_name" != postgres ]; then printf '[0]\\n'; exit 0; fi
awk '${administrativePostgresCredentialAwk}' /proc/1/status
set +e
pg_isready -q -t 2 -U "$1" -d "$2"
probe_status=$?
set -e
case "$probe_status" in
  0) printf '[1]\\n' ;;
  1|2) printf '[0]\\n' ;;
  *) exit 1 ;;
esac
`;
export const administrativePostgresSettlementProgram = `
set -eu
found_main=0
for entry in /proc/[0-9]*/comm; do
  process_id=\${entry#/proc/}
  process_id=\${process_id%/comm}
  if [ "$process_id" = "$$" ]; then continue; fi
  IFS= read -r process_name < "$entry"
  test "$process_name" = postgres
  if [ "$process_id" = 1 ]; then found_main=1; fi
done
test "$found_main" = 1
awk '${administrativePostgresCredentialAwk}' /proc/1/status
printf '[1]\\n'
`;

export async function waitForAdministrativePostgres(
  holder,
  profileName,
  command,
  deadline,
  timing = {
    now: () => performance.now(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
) {
  assertAdministrativeFixtureOwner(holder, holder?.owner);
  const identity = Object.freeze({ containerId: holder.containerId, owner: holder.owner });
  const profile = parseAdministrativePreflightProfile(profileName);
  if (!profile.server || typeof command !== "function") throw invalid();
  const started = timing.now();
  const expired = () => new Error("us_hosted_admin_setup_deadline");
  if (!Number.isFinite(deadline) || deadline <= started) throw expired();
  if (deadline - started > 120000) throw invalid();
  const bounded = async (args) => {
    const remaining = deadline - timing.now();
    if (remaining <= 0) throw expired();
    return command(args, undefined, Math.min(30000, remaining));
  };
  for (;;) {
    assertAdministrativeFixtureOwner(
      identity,
      (
        await bounded([
          "inspect",
          "--format",
          '{{index .Config.Labels "us-fixture-owner"}}',
          identity.containerId,
        ])
      ).trim(),
    );
    const result = (
      await bounded([
        "exec",
        "--user",
        "postgres:postgres",
        identity.containerId,
        "sh",
        "-ec",
        administrativePostgresReadyProgram,
        "us-admin-ready",
        profile.name === "wrongUser" ? "markiro_other" : "markiro_us",
        profile.name === "wrongDatabase" ? "markiro_other" : "markiro_us_synthetic",
      ])
    ).trim();
    if (timing.now() >= deadline) throw expired();
    if (result === "[1]") return Object.freeze({ ...identity, ready: true });
    if (result !== "[0]") throw invalid();
    await timing.delay(Math.min(250, deadline - timing.now()));
  }
}

export async function closeAdministrativePostgres(holder, profileName, command) {
  assertAdministrativeFixtureOwner(holder, holder?.owner);
  const identity = Object.freeze({ containerId: holder.containerId, owner: holder.owner });
  const profile = parseAdministrativePreflightProfile(profileName);
  if (!profile.server || typeof command !== "function") throw invalid();
  const owned = async () =>
    assertAdministrativeFixtureOwner(
      identity,
      (
        await command([
          "inspect",
          "--format",
          '{{index .Config.Labels "us-fixture-owner"}}',
          identity.containerId,
        ])
      ).trim(),
    );
  await owned();
  const clients = (
    await command([
      "exec",
      "--user",
      "postgres:postgres",
      identity.containerId,
      "psql",
      "-X",
      "-A",
      "-t",
      "-q",
      "--no-password",
      "--username",
      profile.name === "wrongUser" ? "markiro_other" : "markiro_us",
      "--dbname",
      "postgres",
      "-c",
      "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()",
    ])
  ).trim();
  if (clients !== "0") throw invalid();
  if (
    (
      await command([
        "exec",
        "--user",
        "postgres:postgres",
        identity.containerId,
        "sh",
        "-ec",
        administrativePostgresSettlementProgram,
      ])
    ).trim() !== "[1]"
  )
    throw invalid();
  await owned();
  await command(["stop", "--time", "2", identity.containerId]);
  if (
    (await command(["inspect", "--format", "{{.State.ExitCode}}", identity.containerId])).trim() !==
    "0"
  )
    throw invalid();
  await owned();
  await command(["rm", identity.containerId]);
  if (
    (
      await command([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        "id=" + identity.containerId,
        "--format",
        "{{.ID}}",
      ])
    ).trim() !== ""
  )
    throw invalid();
  return Object.freeze({ ...identity, absent: true });
}

const caConfiguration = (name) =>
  "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca_ext\n[dn]\nCN=" +
  name +
  "\n[ca_ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n";
const requestConfiguration = (name) =>
  "[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=" + name + "\n";
const serverConfiguration = (name) =>
  "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:" +
  name +
  "\n";
export const administrativePkiSpecification = Object.freeze({
  configurations: Object.freeze({
    "root-ca.cnf": caConfiguration("US Synthetic TEST CA"),
    "other-ca.cnf": caConfiguration("US Synthetic Other TEST CA"),
    "server-req.cnf": requestConfiguration("postgres.us-demo.internal"),
    "server-ext.cnf": serverConfiguration("postgres.us-demo.internal"),
    "wrong-req.cnf": requestConfiguration("wrong.us-demo.internal"),
    "wrong-ext.cnf": serverConfiguration("wrong.us-demo.internal"),
  }),
  commands: Object.freeze(
    [
      [
        "req",
        "-new",
        "-x509",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-config",
        "root-ca.cnf",
        "-keyout",
        "root.key",
        "-out",
        "root.pem",
        "-days",
        "2",
      ],
      [
        "req",
        "-new",
        "-x509",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-config",
        "other-ca.cnf",
        "-keyout",
        "other.key",
        "-out",
        "other.pem",
        "-days",
        "2",
      ],
      [
        "req",
        "-new",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-config",
        "server-req.cnf",
        "-keyout",
        "server.key",
        "-out",
        "server.csr",
      ],
      [
        "x509",
        "-req",
        "-in",
        "server.csr",
        "-CA",
        "root.pem",
        "-CAkey",
        "root.key",
        "-set_serial",
        "2",
        "-days",
        "2",
        "-extfile",
        "server-ext.cnf",
        "-out",
        "server.pem",
      ],
      [
        "req",
        "-new",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-config",
        "wrong-req.cnf",
        "-keyout",
        "wrong.key",
        "-out",
        "wrong.csr",
      ],
      [
        "x509",
        "-req",
        "-in",
        "wrong.csr",
        "-CA",
        "root.pem",
        "-CAkey",
        "root.key",
        "-set_serial",
        "3",
        "-days",
        "2",
        "-extfile",
        "wrong-ext.cnf",
        "-out",
        "wrong.pem",
      ],
    ].map((args) => Object.freeze(args)),
  ),
});
export const administrativeRegressionPkiSpecification = Object.freeze({
  configurations: Object.freeze({
    "root-ca.cnf": caConfiguration("US Synthetic Runtime TEST CA"),
    "api-req.cnf": requestConfiguration("api.us-demo.internal"),
    "api-ext.cnf": serverConfiguration("api.us-demo.internal"),
  }),
  commands: Object.freeze(
    [
      [
        "req",
        "-new",
        "-x509",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-config",
        "root-ca.cnf",
        "-keyout",
        "root.key",
        "-out",
        "root.pem",
        "-days",
        "2",
      ],
      [
        "req",
        "-new",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-config",
        "api-req.cnf",
        "-keyout",
        "api.key",
        "-out",
        "api.csr",
      ],
      [
        "x509",
        "-req",
        "-in",
        "api.csr",
        "-CA",
        "root.pem",
        "-CAkey",
        "root.key",
        "-set_serial",
        "2",
        "-days",
        "2",
        "-extfile",
        "api-ext.cnf",
        "-out",
        "api.pem",
      ],
    ].map((args) => Object.freeze(args)),
  ),
});
const pkiOwners = new WeakMap();
const pkiFiles = Object.freeze([
  ...Object.keys(administrativePkiSpecification.configurations),
  "root.key",
  "root.pem",
  "other.key",
  "other.pem",
  "server.key",
  "server.csr",
  "server.pem",
  "wrong.key",
  "wrong.csr",
  "wrong.pem",
]);

/** Called only after the runner's fresh exact-package byte proof; creates no Docker resource. */
export async function createAdministrativePki(locator, root, execute = execFile) {
  return createAdministrativePkiSet(locator, root, "administrative", execute);
}
export async function createAdministrativeRegressionPki(locator, root, execute = execFile) {
  return createAdministrativePkiSet(locator, root, "runtime-regression", execute);
}
async function createAdministrativePkiSet(locator, root, kind, execute) {
  if (!["administrative", "runtime-regression"].includes(kind)) throw invalid();
  const specification =
    kind === "administrative"
      ? administrativePkiSpecification
      : administrativeRegressionPkiSpecification;
  const files =
    kind === "administrative"
      ? pkiFiles
      : Object.freeze([
          ...Object.keys(specification.configurations),
          "root.key",
          "root.pem",
          "api.key",
          "api.csr",
          "api.pem",
        ]);
  const stems = kind === "administrative" ? ["root", "other", "server", "wrong"] : ["root", "api"];
  const selected = parseAdministrativePackageLocator(JSON.stringify(locator), root);
  const parent = dirname(selected.source);
  const parentStat = await lstat(parent);
  const uid = process.getuid?.();
  if (
    typeof uid !== "number" ||
    !parentStat.isDirectory() ||
    parentStat.uid !== uid ||
    (parentStat.mode & 0o022) !== 0 ||
    (await realpath(parent)) !== parent
  )
    throw invalid();
  const directory = resolve(
    parent,
    kind === "administrative" ? "private-test-pki" : "private-runtime-test-pki",
  );
  await mkdir(directory, { mode: 0o700 }); // Exclusive: an existing invocation is never adopted.
  const handle = Object.freeze({ purpose: "synthetic-test-only", directory });
  const record = {
    directory,
    kind,
    files,
    uid,
    buffers: new Map(),
    completed: false,
    closed: false,
    proof: null,
  };
  pkiOwners.set(handle, record);
  const checkFile = async (name) => {
    const path = resolve(directory, name),
      stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      stat.nlink !== 1 ||
      stat.size > 65536 ||
      (name.endsWith(".key") && (stat.mode & 0o777) !== 0o600)
    )
      throw invalid();
    await chmod(path, 0o600);
  };
  try {
    const own = await lstat(directory);
    if (!own.isDirectory() || own.uid !== uid || (own.mode & 0o777) !== 0o700) throw invalid();
    for (const [name, content] of Object.entries(specification.configurations))
      await writeFile(resolve(directory, name), content, { flag: "wx", mode: 0o600 });
    for (const args of specification.commands) {
      await new Promise((resolveCommand, rejectCommand) => {
        try {
          let stdinFailed = false;
          const child = execute(
            "openssl",
            [...args],
            {
              cwd: directory,
              env: { PATH: process.env.PATH },
              encoding: "utf8",
              timeout: 30000,
              maxBuffer: 1048576,
              shell: false,
            },
            (error) =>
              error || stdinFailed
                ? rejectCommand(new Error("us_hosted_admin_pki_failed"))
                : resolveCommand(),
          );
          try {
            child.stdin?.on("error", () => {
              stdinFailed = true;
            });
            child.stdin?.end();
          } catch {
            stdinFailed = true;
          } // A launched local child still waits for its completion callback.
        } catch {
          rejectCommand(new Error("us_hosted_admin_pki_failed"));
        }
      });
      for (const name of await readdir(directory)) {
        if (!files.includes(name)) throw invalid();
        await checkFile(name);
      }
    }
    if ((await readdir(directory)).length !== files.length) throw invalid();
    for (const stem of stems) {
      record.buffers.set(stem + ".pem", await readFile(resolve(directory, stem + ".pem")));
      if (stem !== "root" && stem !== "other")
        record.buffers.set(stem + ".key", await readFile(resolve(directory, stem + ".key")));
    }
    const certs = {};
    for (const stem of stems) {
      const cert = new X509Certificate(record.buffers.get(stem + ".pem"));
      if (
        cert.ca !== (stem === "root" || stem === "other") ||
        Date.parse(cert.validFrom) > Date.now() ||
        Date.parse(cert.validTo) <= Date.now()
      )
        throw invalid();
      const keyBytes =
        stem === "root" || stem === "other"
          ? await readFile(resolve(directory, stem + ".key"))
          : record.buffers.get(stem + ".key");
      try {
        if (!cert.checkPrivateKey(createPrivateKey(keyBytes))) throw invalid();
      } finally {
        if (stem === "root" || stem === "other") keyBytes.fill(0);
      }
      certs[stem] = cert;
    }
    if (kind === "administrative") {
      if (
        certs.root.fingerprint256 === certs.other.fingerprint256 ||
        !certs.server.verify(certs.root.publicKey) ||
        !certs.wrong.verify(certs.root.publicKey) ||
        certs.server.checkHost("postgres.us-demo.internal") !== "postgres.us-demo.internal" ||
        certs.wrong.checkHost("postgres.us-demo.internal") !== undefined ||
        certs.wrong.checkHost("wrong.us-demo.internal") !== "wrong.us-demo.internal"
      )
        throw invalid();
    } else if (
      !certs.api.verify(certs.root.publicKey) ||
      certs.api.checkHost("api.us-demo.internal", {
        subject: "never",
        wildcards: false,
        partialWildcards: false,
        multiLabelWildcards: false,
        singleLabelSubdomains: false,
      }) !== "api.us-demo.internal"
    )
      throw invalid();
    record.completed = true;
    return handle;
  } catch {
    const error = new Error("us_hosted_admin_pki_failed");
    error.pkiOwner = handle; // Redacted identity permits caller-owned failure cleanup; no secret/cause.
    throw error;
  }
}

export function administrativePkiMaterial(handle, profileName) {
  const record = pkiOwners.get(handle);
  const profile = parseAdministrativePreflightProfile(profileName);
  if (!record || record.kind !== "administrative" || !record.completed || record.closed)
    throw invalid();
  const get = (name) => record.buffers.get(name).toString("utf8");
  const stem = profile.name === "wrongName" ? "wrong" : "server";
  return {
    dbPassword: randomBytes(32).toString("hex"),
    storageAccess: randomBytes(24).toString("hex"),
    storageSecret: randomBytes(48).toString("hex"),
    dbCA: get(profile.name === "wrongCA" ? "other.pem" : "root.pem"),
    storageCA: get("root.pem"),
    serverCertificate: get(stem + ".pem") + get("root.pem"),
    serverKey: get(stem + ".key"),
  };
}

export async function disposeAdministrativePki(handle) {
  const record = pkiOwners.get(handle);
  if (!record) throw invalid();
  if (record.closed) return record.proof;
  const directoryStat = await lstat(record.directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.uid !== record.uid ||
    (directoryStat.mode & 0o777) !== 0o700
  )
    throw invalid();
  const names = await readdir(record.directory);
  for (const name of names) {
    if (!record.files.includes(name)) throw invalid();
    const stat = await lstat(resolve(record.directory, name));
    if (
      !stat.isFile() ||
      stat.uid !== record.uid ||
      stat.nlink !== 1 ||
      (name.endsWith(".key")
        ? (stat.mode & 0o777) !== 0o600
        : ![0o600, 0o644].includes(stat.mode & 0o777))
    )
      throw invalid();
  }
  for (const name of names) await unlink(resolve(record.directory, name));
  await rmdir(record.directory);
  let absent = false;
  try {
    await lstat(record.directory);
  } catch (error) {
    if (error.code === "ENOENT") absent = true;
    else throw invalid();
  }
  if (!absent) throw invalid();
  for (const buffer of record.buffers.values()) buffer.fill(0);
  record.buffers.clear();
  record.closed = true;
  record.proof = Object.freeze({
    purpose: "synthetic-test-only",
    privatePkiDeleted: true,
    ownedFilesRemoved: names.length,
  });
  return record.proof;
}

const administrativeSha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inventoryPath = (value) => {
  if (
    typeof value !== "string" ||
    !value ||
    /[\p{Cc}\\]/u.test(value) ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw invalid();
  return value;
};
const sameAdministrativeStat = (left, right) =>
  ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtimeNs", "ctimeNs"].every(
    (key) => left[key] === right[key],
  );

async function hashAdministrativeFile(path, before, buffer, captureLimit) {
  if (
    !before.isFile() ||
    before.size < 0n ||
    before.size > BigInt(Number.MAX_SAFE_INTEGER) ||
    (captureLimit !== undefined && before.size > BigInt(captureLimit))
  )
    throw invalid();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const captured = [];
  try {
    if (!sameAdministrativeStat(before, await file.stat({ bigint: true }))) throw invalid();
    const hash = createHash("sha256");
    let count = 0;
    for (;;) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - count + 1),
        count,
      );
      if (!bytesRead) break;
      count += bytesRead;
      if (count > Number(before.size)) throw invalid();
      hash.update(buffer.subarray(0, bytesRead));
      if (captureLimit !== undefined) captured.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    if (
      count !== Number(before.size) ||
      !sameAdministrativeStat(before, await file.stat({ bigint: true })) ||
      !sameAdministrativeStat(before, await lstat(path, { bigint: true }))
    )
      throw invalid();
    return {
      byteSize: count,
      sha256: hash.digest("hex"),
      ...(captureLimit === undefined ? {} : { metadata: Buffer.concat(captured) }),
    };
  } finally {
    for (const bytes of captured) bytes.fill(0);
    await file.close();
  }
}

async function confinedAdministrativeLink(base, path, target) {
  if (typeof target !== "string" || target.startsWith("/") || /[\p{Cc}]/u.test(target))
    throw invalid();
  let candidate = resolve(dirname(path), target),
    hops = 0;
  for (;;) {
    if (!candidate.startsWith(base + sep)) throw invalid();
    const parts = relative(base, candidate).split(sep);
    let cursor = base,
      redirected = false;
    for (let index = 0; index < parts.length; index++) {
      cursor = resolve(cursor, parts[index]);
      let stat;
      try {
        stat = await lstat(cursor);
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw invalid();
      }
      if (stat.isSymbolicLink()) {
        if (++hops > 40) throw invalid();
        const link = await readlink(cursor);
        if (link.startsWith("/") || /[\p{Cc}]/u.test(link)) throw invalid();
        candidate = resolve(dirname(cursor), link, ...parts.slice(index + 1));
        redirected = true;
        break;
      }
      if (index < parts.length - 1 && !stat.isDirectory()) throw invalid();
    }
    if (!redirected) return;
  }
}

/** Byte/link inventory only. This function never issues a genuine administrative release. */
export async function verifyAdministrativeFileInventory(base, records, roots, allowLinks) {
  const scratch = Buffer.alloc(65536);
  try {
    if (
      typeof base !== "string" ||
      !Array.isArray(records) ||
      !Array.isArray(roots) ||
      typeof allowLinks !== "boolean" ||
      !(await lstat(base)).isDirectory()
    )
      throw invalid();
    base = await realpath(base);
    const actual = new Map();
    async function walk(path) {
      inventoryPath(path);
      const absolute = resolve(base, path),
        stat = await lstat(absolute, { bigint: true });
      if (stat.isDirectory()) {
        for (const name of (await readdir(absolute)).sort()) await walk(path + "/" + name);
      } else {
        if ((!stat.isFile() && !(allowLinks && stat.isSymbolicLink())) || actual.has(path))
          throw invalid();
        actual.set(path, stat);
      }
    }
    for (const root of roots) {
      inventoryPath(root);
      const parts = root.split("/");
      let cursor = base;
      for (const part of parts.slice(0, -1)) {
        cursor = resolve(cursor, part);
        if (!(await lstat(cursor)).isDirectory()) throw invalid();
      }
      await walk(root);
    }
    const selected = new Map();
    for (const record of records) {
      if (!record || typeof record !== "object" || Array.isArray(record)) throw invalid();
      const path = inventoryPath(record.path),
        keys = Object.keys(record);
      if (selected.has(path) || !actual.has(path)) throw invalid();
      if (Object.hasOwn(record, "link")) {
        if (
          !allowLinks ||
          keys.length !== 2 ||
          !keys.includes("path") ||
          !keys.includes("link") ||
          typeof record.link !== "string"
        )
          throw invalid();
      } else if (
        keys.length !== 3 ||
        !keys.every((key) => ["path", "byteSize", "sha256"].includes(key)) ||
        !Number.isSafeInteger(record.byteSize) ||
        record.byteSize < 0 ||
        typeof record.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.sha256)
      )
        throw invalid();
      selected.set(path, record);
    }
    if (selected.size !== actual.size) throw invalid();
    const sbom = [];
    for (const [path, before] of actual) {
      const record = selected.get(path),
        absolute = resolve(base, path);
      if (before.isSymbolicLink()) {
        if (!Object.hasOwn(record, "link") || (await readlink(absolute)) !== record.link)
          throw invalid();
        await confinedAdministrativeLink(base, absolute, record.link);
        if (!sameAdministrativeStat(before, await lstat(absolute, { bigint: true })))
          throw invalid();
      } else {
        if (
          Object.hasOwn(record, "link") ||
          record.byteSize !== Number(before.size) ||
          (!allowLinks && before.size > 32n * 1024n * 1024n)
        )
          throw invalid();
        const capture = allowLinks && path.endsWith("/package.json");
        const hashed = await hashAdministrativeFile(
          absolute,
          before,
          scratch,
          capture ? 1048576 : undefined,
        );
        try {
          if (hashed.sha256 !== record.sha256) throw invalid();
          if (capture) {
            const metadata = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(hashed.metadata),
            );
            if (
              metadata &&
              typeof metadata.name === "string" &&
              typeof metadata.version === "string"
            )
              sbom.push(
                Object.freeze({
                  path,
                  name: metadata.name,
                  version: metadata.version,
                  sha256: record.sha256,
                }),
              );
          }
        } finally {
          hashed.metadata?.fill(0);
        }
      }
    }
    return Object.freeze({
      entries: actual.size,
      sbom: Object.freeze(sbom.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))),
    });
  } catch {
    throw invalid();
  } finally {
    scratch.fill(0);
  }
}

export const administrativePreflightSourcePaths = Object.freeze([
  "apps/api/src/deployment/us-hosted-admin-file-reader.ts",
  "apps/api/src/deployment/us-hosted-admin-material-owner.ts",
  "apps/api/src/deployment/us-hosted-admin-database.ts",
  "apps/api/test/us-hosted-admin-file-reader.test.ts",
  "apps/api/test/us-hosted-admin-material-owner.test.ts",
  "apps/api/test/us-hosted-admin-database.test.ts",
  "apps/api/test/us-hosted-admin-preflight-installed.e2e.test.ts",
  "apps/api/test/support/us-hosted-admin-preflight-fixture.mjs",
  "tools/us-development/verify-hosted-admin-preflight.mjs",
  "tools/us-development/test/hosted-admin-preflight.test.mjs",
  "deploy/us-synthetic/README.md",
]);
const administrativeArtifactRoots = Object.freeze([
  "apps/api/dist",
  "packages/db/dist",
  "packages/domain/dist",
  "packages/platform-contracts/dist",
  "apps/admin/dist-us",
  "packages/db/migrations",
]);
const administrativeMetadataPaths = Object.freeze([
  "pnpm-lock.yaml",
  "apps/api/package.json",
  "packages/db/package.json",
  "packages/domain/package.json",
  "packages/platform-contracts/package.json",
]);
const administrativeDependencyRoots = Object.freeze([
  "node_modules",
  "apps/api/node_modules",
  "packages/db/node_modules",
  "packages/domain/node_modules",
  "packages/platform-contracts/node_modules",
]);
const administrativeDeploymentPaths = Object.freeze([
  "deploy/us-synthetic/package-spec.json",
  "deploy/us-synthetic/compose.synthetic.yml",
  "deploy/us-synthetic/ingress.conf",
  "deploy/us-synthetic/runtime.Dockerfile",
  "deploy/us-synthetic/README.md",
]);

async function readAdministrativeGit(cwd, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "buffer", timeout: 30000, maxBuffer: 8 * 1024 * 1024, shell: false },
      (error, stdout) => (error ? rejectCommand(invalid()) : resolveCommand(stdout)),
    );
  });
}
async function administrativeCapturedFile(path, limit) {
  const scratch = Buffer.alloc(65536);
  try {
    return await hashAdministrativeFile(path, await lstat(path, { bigint: true }), scratch, limit);
  } finally {
    scratch.fill(0);
  }
}

/** Fresh TEST-package proof only: never promotes a fixture or opens a network/database. */
export async function verifyAdministrativeFixturePackage(
  locator,
  root,
  git = readAdministrativeGit,
) {
  const retained = [];
  try {
    const selected = parseAdministrativePackageLocator(JSON.stringify(locator), root);
    if ((await realpath(selected.source)) !== selected.source) throw invalid();
    const readGit = async (cwd, args) => {
      const value = await git(cwd, args);
      return Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    };
    if (
      (await readGit(root, ["rev-parse", "HEAD"])).toString("utf8").trim() !== selected.baseSha ||
      (await readGit(selected.source, ["rev-parse", "HEAD"])).toString("utf8").trim() !==
        selected.fixtureSha ||
      (await readGit(selected.source, ["rev-parse", "HEAD^"])).toString("utf8").trim() !==
        selected.baseSha ||
      (await readGit(selected.source, ["status", "--porcelain=v1", "--untracked-files=all"]))
        .length !== 0 ||
      administrativeSha(
        await readGit(selected.source, [
          "show",
          "--format=",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          "--no-textconv",
          "HEAD",
        ]),
      ) !== selected.patchSha256
    )
      throw invalid();
    const changed = (
      await readGit(selected.source, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
    )
      .toString("utf8")
      .trim()
      .split("\n")
      .sort();
    if (!isDeepStrictEqual(changed, [...administrativePreflightSourcePaths].sort()))
      throw invalid();
    const sourceHashes = [];
    for (const path of administrativePreflightSourcePaths) {
      const current = await administrativeCapturedFile(resolve(root, path), 32 * 1024 * 1024);
      const fixture = await administrativeCapturedFile(
        resolve(selected.source, path),
        32 * 1024 * 1024,
      );
      try {
        if (current.sha256 !== fixture.sha256 || current.byteSize !== fixture.byteSize)
          throw invalid();
        sourceHashes.push(
          Object.freeze({ path, byteSize: current.byteSize, sha256: current.sha256 }),
        );
      } finally {
        current.metadata.fill(0);
        fixture.metadata.fill(0);
      }
    }
    const stage = resolve(selected.source, ".superpowers/us-hosted-package"),
      app = resolve(stage, "app");
    if (
      !(await lstat(stage)).isDirectory() ||
      (await realpath(stage)) !== stage ||
      !(await lstat(app)).isDirectory()
    )
      throw invalid();
    const load = async (path) => {
      const captured = await administrativeCapturedFile(path, 64 * 1024 * 1024);
      retained.push(captured.metadata);
      return {
        bytes: captured.metadata,
        value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(captured.metadata)),
      };
    };
    const runtime = await load(resolve(app, "us-synthetic-release.json"));
    const admin = await load(resolve(app, "us-synthetic-admin-release.json"));
    const deps = await load(resolve(stage, "dependency-attestation.json"));
    const deploy = await load(resolve(stage, "deployment-attestation.json"));
    const m = runtime.value,
      b = admin.value,
      d = deps.value,
      a = deploy.value;
    if (
      !m ||
      !b ||
      !d ||
      !a ||
      m.schemaVersion !== 1 ||
      b.schemaVersion !== 1 ||
      d.schemaVersion !== 1 ||
      a.schemaVersion !== 1 ||
      m.edition !== "US" ||
      b.edition !== "US" ||
      m.purpose !== "synthetic-demo" ||
      b.purpose !== "synthetic-demo" ||
      m.build?.gitSha !== selected.fixtureSha ||
      b.sourceSha !== selected.fixtureSha ||
      a.sourceSha !== selected.fixtureSha ||
      administrativeSha(runtime.bytes) !== selected.manifestSha256 ||
      administrativeSha(admin.bytes) !== selected.adminManifestSha256 ||
      b.runtimeManifestSha256 !== selected.manifestSha256 ||
      a.manifestSha256 !== selected.manifestSha256 ||
      a.dependencyAttestationSha256 !== administrativeSha(deps.bytes) ||
      a.protectedImageAttestationRequired !== true ||
      ["imageDigestVerified", "deploymentReady", "releaseEnabled"].some((key) => a[key] !== false)
    )
      throw invalid();
    for (const path of [...administrativeArtifactRoots, ...administrativeDependencyRoots])
      if (!(await lstat(resolve(app, path))).isDirectory()) throw invalid();
    const artifacts = await verifyAdministrativeFileInventory(
      app,
      m.files,
      [...administrativeArtifactRoots, ...administrativeMetadataPaths],
      false,
    );
    const dependency = await verifyAdministrativeFileInventory(
      app,
      d.files,
      administrativeDependencyRoots,
      true,
    );
    const deployment = await verifyAdministrativeFileInventory(
      stage,
      a.files,
      administrativeDeploymentPaths,
      false,
    );
    const entry = m.files.filter((file) => file.path === "apps/api/dist/main.us-hosted-admin.js");
    if (
      entry.length !== 1 ||
      !isDeepStrictEqual(entry[0], b.entrypoint) ||
      !Array.isArray(d.sbom) ||
      !isDeepStrictEqual(
        [...d.sbom].sort((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
        ),
        dependency.sbom,
      )
    )
      throw invalid();
    for (const path of administrativeDeploymentPaths) {
      const source = await administrativeCapturedFile(
        resolve(selected.source, path),
        32 * 1024 * 1024,
      );
      try {
        const recorded = a.files.find((file) => file.path === path);
        if (!recorded || source.sha256 !== recorded.sha256 || source.byteSize !== recorded.byteSize)
          throw invalid();
      } finally {
        source.metadata.fill(0);
      }
    }
    // Close the whole copied stage as well: no unlisted file is sent to Docker.
    const expected = new Set([...m.files, ...d.files].map((file) => "app/" + file.path));
    for (const path of [
      "app/us-synthetic-release.json",
      "app/us-synthetic-admin-release.json",
      "dependency-attestation.json",
      "deployment-attestation.json",
      ...administrativeDeploymentPaths,
    ])
      expected.add(path);
    const found = new Set();
    async function shape(path) {
      const absolute = resolve(stage, path),
        stat = await lstat(absolute);
      if (stat.isDirectory())
        for (const name of await readdir(absolute)) await shape(path ? path + "/" + name : name);
      else {
        if (!stat.isFile() && !stat.isSymbolicLink()) throw invalid();
        found.add(path);
      }
    }
    await shape("");
    if (found.size !== expected.size || [...found].some((path) => !expected.has(path)))
      throw invalid();
    if (
      (await readGit(selected.source, ["rev-parse", "HEAD"])).toString("utf8").trim() !==
        selected.fixtureSha ||
      (await readGit(selected.source, ["status", "--porcelain=v1", "--untracked-files=all"]))
        .length !== 0
    )
      throw invalid();
    return Object.freeze({
      purpose: "synthetic-test-only",
      fixtureArtifactsPromotable: false,
      fixtureSha: selected.fixtureSha,
      manifestSha256: selected.manifestSha256,
      adminManifestSha256: selected.adminManifestSha256,
      artifactFiles: artifacts.entries,
      dependencyEntries: dependency.entries,
      sbomEntries: dependency.sbom.length,
      deploymentFiles: deployment.entries,
      currentSourceHashes: Object.freeze(sourceHashes),
      imageDigestVerified: false,
      deploymentReady: false,
      releaseEnabled: false,
    });
  } catch {
    throw invalid();
  } finally {
    for (const bytes of retained) bytes.fill(0);
  }
}

async function administrativeAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw invalid();
  }
  throw invalid();
}
export async function administrativeLocalPreflight(client) {
  if (
    ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"].some(
      (name) => process.env[name] !== undefined,
    )
  )
    throw invalid();
  const endpoint = JSON.parse(
    await client.run(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]),
  );
  if (typeof endpoint !== "string" || !endpoint.startsWith("unix:///")) throw invalid();
  for (const image of [administrativeNodeImage, administrativePostgresImage])
    if (
      (
        await client.run([
          "image",
          "inspect",
          image,
          "--format",
          "{{.Id}} {{.Os}} {{.Architecture}}",
        ])
      ).trim() !==
      image + " linux arm64"
    )
      throw invalid();
}
const administrativeNativeTopologyDependencies = Object.freeze({
  verify: verifyAdministrativeFixturePackage,
  createClient: createAdministrativeDockerClient,
  preflight: administrativeLocalPreflight,
  createPki: createAdministrativePki,
  pkiMaterial: administrativePkiMaterial,
  acquireResources: acquireAdministrativeFixtureResources,
  createHolder: createAdministrativeHolder,
  closeHolder: closeAdministrativeHolder,
  createPostgres: createAdministrativePostgres,
  waitPostgres: waitForAdministrativePostgres,
  closePostgres: closeAdministrativePostgres,
  closeVolume: closeAdministrativeVolume,
  closeNetwork: closeAdministrativeNetwork,
  disposePki: disposeAdministrativePki,
  assertAbsent: administrativeAbsent,
  writeReceipt: async (path, bytes) => {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  },
  readReceipt: async (path) => (await administrativeCapturedFile(path, 16384)).metadata,
  archiveReceipt: async (current, archive, bytes) => {
    await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
    await unlink(current);
  },
  now: () => performance.now(),
});
const administrativeTopologyOwners = new WeakMap();

/** Default execution is native. An explicit test-only dependency model is always marked protocolOnly. */
export async function prepareAdministrativeTopology(
  locator,
  root,
  persist,
  dependencies = administrativeNativeTopologyDependencies,
) {
  const selected = parseAdministrativePackageLocator(JSON.stringify(locator), root);
  if (
    typeof persist !== "function" ||
    !dependencies ||
    Object.keys(dependencies).length !==
      Object.keys(administrativeNativeTopologyDependencies).length ||
    Object.keys(administrativeNativeTopologyDependencies).some(
      (name) => typeof dependencies[name] !== "function",
    )
  )
    throw invalid();
  const handle = Object.freeze({ purpose: "synthetic-test-only", fixtureSha: selected.fixtureSha });
  const receiptPath = resolve(
    root,
    ".superpowers/sdd/2026-10-22-us-11-demo-viewer/installed-fixtures/admin-preflight-current.json",
  );
  const archivePath = resolve(dirname(selected.source), "admin-preflight-closed-receipt.json");
  const state = {
    schemaVersion: 1,
    purpose: "synthetic-test-only",
    fixtureSha: selected.fixtureSha,
    protocolOnly: dependencies !== administrativeNativeTopologyDependencies,
    phase: "initial",
    activeProfile: null,
    packageProof: null,
    pkiDirectory: resolve(dirname(selected.source), "private-test-pki"),
    profiles: {},
  };
  const record = {
    selected,
    root,
    state,
    dependencies,
    client: null,
    pki: null,
    prepared: false,
    closed: false,
    closePromise: null,
    receiptPath,
    archivePath,
    receiptBytes: null,
  };
  administrativeTopologyOwners.set(handle, record);
  const checkpoint = async (phase) => {
    state.phase = phase;
    await persist(structuredClone(state));
  };
  try {
    await checkpoint("package_verification");
    state.packageProof = await dependencies.verify(selected, root);
    if (
      state.packageProof.fixtureArtifactsPromotable !== false ||
      ["imageDigestVerified", "deploymentReady", "releaseEnabled"].some(
        (key) => state.packageProof[key] !== false,
      ) ||
      state.packageProof.fixtureSha !== selected.fixtureSha
    )
      throw invalid();
    await checkpoint("package_verified");
    await dependencies.assertAbsent(receiptPath);
    await dependencies.assertAbsent(archivePath);
    record.client = dependencies.createClient();
    await dependencies.preflight(record.client);
    await checkpoint("local_preflight_verified");
    await checkpoint("pki_creation_intent");
    record.pki = await dependencies.createPki(selected, root);
    await checkpoint("pki_created");
    for (const profile of administrativePreflightProfiles) {
      state.activeProfile = profile.name;
      const entry = {
        phase: "initial",
        resources: null,
        preparer: null,
        preparerClosure: null,
        holder: null,
        server: null,
        copyEvidence: null,
      };
      state.profiles[profile.name] = entry;
      const deadline = dependencies.now() + 120000; // Starts BEFORE the first resource acquisition.
      const command = async (args, input, timeoutLimit) => {
        const remaining = deadline - dependencies.now();
        if (remaining <= 0) throw new Error("us_hosted_admin_setup_deadline");
        const cap = args[0] === "cp" ? 90000 : 30000;
        return record.client.run(args, input, Math.min(cap, remaining, timeoutLimit ?? cap));
      };
      const event = async (value) => {
        entry.phase = value.phase;
        if (Object.hasOwn(value, "volumes")) entry.resources = value;
        if (value.holder) {
          if (value.holderPhase === "prepare") entry.preparer = value.holder;
          else if (value.holderPhase === "holder") entry.holder = value.holder;
          else if (value.phase.startsWith("postgres_")) entry.server = value.holder;
        }
        await checkpoint(value.phase);
      };
      await checkpoint("profile_acquisition_intent");
      entry.resources = await dependencies.acquireResources(profile.name, command, event);
      entry.preparer = await dependencies.createHolder(entry.resources, "prepare", command, event);
      await checkpoint("package_copy_intent");
      const copiedAt = dependencies.now();
      await command([
        "cp",
        resolve(selected.source, ".superpowers/us-hosted-package/app") + "/.",
        entry.preparer.containerId + ":/app",
      ]);
      entry.copyEvidence = {
        deadlineSeconds: 90,
        elapsedMilliseconds: dependencies.now() - copiedAt,
        exitCode: 0,
        actualClientSettled: true,
      };
      await checkpoint("package_copied");
      const material = dependencies.pkiMaterial(record.pki, profile.name); // Exactly one projection per profile.
      const payload = Buffer.from(
        JSON.stringify({
          profile: profile.name,
          config: administrativeConfiguration(selected, profile.name),
          ...material,
        }),
      );
      try {
        await checkpoint("protected_material_preparation");
        if (
          (
            await command(
              [
                "exec",
                "-i",
                "--user",
                "0:0",
                entry.preparer.containerId,
                "node",
                "-e",
                administrativePreparationProgram,
              ],
              payload,
            )
          ).trim() !== "[1]"
        )
          throw invalid();
      } finally {
        payload.fill(0);
      }
      entry.preparerClosure = await dependencies.closeHolder(entry.preparer, command);
      if (entry.preparerClosure.absent !== true) throw invalid();
      await checkpoint("preparer_closed_normally");
      if (profile.server) {
        entry.server = await dependencies.createPostgres(entry.resources, command, event);
        await dependencies.waitPostgres(entry.server, profile.name, command, deadline);
      }
      entry.holder = await dependencies.createHolder(entry.resources, "holder", command, event);
      if (dependencies.now() >= deadline) throw new Error("us_hosted_admin_setup_deadline");
      entry.phase = "prepared";
      await checkpoint("profile_prepared");
    }
    state.activeProfile = null;
    const fixtures = {};
    for (const profile of administrativePreflightProfiles) {
      const entry = state.profiles[profile.name];
      fixtures[profile.name] = {
        ...entry.holder,
        network: entry.resources.network?.name ?? "none",
      };
    }
    record.receiptBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        purpose: "synthetic-test-only",
        baseSha: selected.baseSha,
        patchSha256: selected.patchSha256,
        fixtureSha: selected.fixtureSha,
        manifestSha256: selected.manifestSha256,
        adminManifestSha256: selected.adminManifestSha256,
        fixtures,
      }) + "\n",
    );
    if (record.receiptBytes.length > 16384) throw invalid();
    await checkpoint("receipt_write_intent");
    await dependencies.writeReceipt(receiptPath, record.receiptBytes);
    record.prepared = true;
    await checkpoint("prepared_for_actual_tests");
    return handle;
  } catch (error) {
    if (error?.pkiOwner) record.pki = error.pkiOwner;
    state.failurePhase = state.phase;
    state.failureKind = /^us_hosted_admin_[a-z_]+$/.test(error?.message ?? "")
      ? error.message
      : "us_hosted_admin_topology_failed";
    try {
      await checkpoint("failed_owned_state_retained");
    } catch {
      /* Preserve the original owned in-memory state. */
    }
    const failure = new Error("us_hosted_admin_topology_failed");
    failure.topologyOwner = handle;
    throw failure;
  }
}

export function inspectAdministrativeTopology(handle) {
  const record = administrativeTopologyOwners.get(handle);
  if (!record) throw invalid();
  return structuredClone(record.state);
}

/** Only a fully prepared topology can take this normal-close path; failed copy state is never auto-cleaned. */
export function closeAdministrativeTopology(handle, persist) {
  const record = administrativeTopologyOwners.get(handle);
  if (!record || !record.prepared || typeof persist !== "function")
    return Promise.reject(invalid());
  if (record.closePromise) return record.closePromise;
  record.closePromise = (async () => {
    const { dependencies, client, state } = record;
    const checkpoint = async (phase) => {
      state.phase = phase;
      await persist(structuredClone(state));
    };
    await client.settle();
    const actual = await dependencies.readReceipt(record.receiptPath);
    try {
      if (administrativeSha(actual) !== administrativeSha(record.receiptBytes)) throw invalid();
    } finally {
      actual.fill(0);
    }
    const proof = {
      purpose: "synthetic-test-only",
      protocolOnly: state.protocolOnly,
      removedHolders: 0,
      removedPostgres: 0,
      removedVolumes: 0,
      removedNetworks: 0,
    };
    for (const profile of administrativePreflightProfiles) {
      const entry = state.profiles[profile.name];
      state.activeProfile = profile.name;
      if (entry.preparerClosure?.absent !== true) throw invalid();
      await checkpoint("holder_normal_close");
      entry.holderClosure = await dependencies.closeHolder(entry.holder, client.run);
      if (entry.holderClosure.absent !== true) throw invalid();
      proof.removedHolders++;
      if (entry.server) {
        await checkpoint("postgres_normal_close");
        entry.serverClosure = await dependencies.closePostgres(
          entry.server,
          profile.name,
          client.run,
        );
        if (entry.serverClosure.absent !== true) throw invalid();
        proof.removedPostgres++;
      }
      entry.volumeClosures = [];
      for (const volume of entry.resources.volumes) {
        await checkpoint("volume_normal_close");
        const closed = await dependencies.closeVolume(
          { name: volume.name, owner: volume.owner },
          client.run,
        );
        if (closed.absent !== true) throw invalid();
        entry.volumeClosures.push(closed);
        proof.removedVolumes++;
      }
      if (entry.resources.network) {
        await checkpoint("network_normal_close");
        const network = entry.resources.network;
        entry.networkClosure = await dependencies.closeNetwork(
          { name: network.name, owner: network.owner },
          client.run,
        );
        if (entry.networkClosure.absent !== true) throw invalid();
        proof.removedNetworks++;
      }
    }
    state.activeProfile = null;
    if (
      proof.removedHolders !== 12 ||
      proof.removedPostgres !== 8 ||
      proof.removedVolumes !== 32 ||
      proof.removedNetworks !== 8
    )
      throw invalid();
    await client.settle();
    await checkpoint("private_pki_normal_delete");
    state.pkiClosure = await dependencies.disposePki(record.pki);
    if (state.pkiClosure.privatePkiDeleted !== true || state.pkiClosure.ownedFilesRemoved !== 16)
      throw invalid();
    await dependencies.assertAbsent(record.archivePath);
    await checkpoint("receipt_archive");
    await dependencies.archiveReceipt(record.receiptPath, record.archivePath, record.receiptBytes);
    record.closed = true;
    record.closureProof = Object.freeze({
      ...proof,
      privatePkiDeleted: true,
      receiptArchived: true,
    });
    state.closureProof = record.closureProof;
    await checkpoint("closed_normally");
    return record.closureProof;
  })();
  return record.closePromise;
}

export function administrativeRegressionPkiMaterial(handle) {
  const record = pkiOwners.get(handle);
  if (!record || record.kind !== "runtime-regression" || !record.completed || record.closed)
    throw invalid();
  return {
    ca: record.buffers.get("root.pem").toString("utf8"),
    certificate:
      record.buffers.get("api.pem").toString("utf8") +
      record.buffers.get("root.pem").toString("utf8"),
    key: record.buffers.get("api.key").toString("utf8"),
  };
}

export function administrativeRegressionRuntimeConfiguration(locator, service) {
  if (!["api", "worker"].includes(service)) throw invalid();
  administrativeConfiguration(locator, "migrate"); // The same fixed SHA syntax; no authority is issued.
  const config = {
    schemaVersion: 1,
    edition: "US",
    purpose: "synthetic-demo",
    mode: "production",
    service,
    publicOrigin: "https://us-demo.invalid",
    release: Object.freeze({
      sourceSha: locator.fixtureSha,
      manifestSha256: locator.manifestSha256,
      manifestFile: "/app/us-synthetic-release.json",
    }),
    database: Object.freeze({
      host: "postgres.us-demo.internal",
      port: 5432,
      name: "markiro_us_synthetic",
      user: "markiro_us_" + service,
      caFile: "/run/secrets/us-demo/db-ca.pem",
      passwordFile: "/run/secrets/us-demo/" + service + "-db-password",
    }),
    storage: Object.freeze({
      endpoint: "https://objects.us-demo.internal",
      bucket: "markiro-us-synthetic-private",
      signingRegion: "us-east-1",
      caFile: "/run/secrets/us-demo/storage-ca.pem",
      accessKeyFile: "/run/secrets/us-demo/" + service + "-storage-access-key",
      secretKeyFile: "/run/secrets/us-demo/" + service + "-storage-secret-key",
      forcePathStyle: true,
    }),
  };
  if (service === "api") {
    config.auth = Object.freeze({ secretFile: "/run/secrets/us-demo/api-auth-secret" });
    config.tls = Object.freeze({
      certificateFile: "/run/secrets/us-demo/api-cert.pem",
      privateKeyFile: "/run/secrets/us-demo/api-key.pem",
    });
  }
  return Object.freeze(config);
}

export const administrativeRegressionPackageProgram = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto');
if(process.getuid()!==0)throw Error('us_hosted_admin_regression_preparation_failed');
const x=JSON.parse(fs.readFileSync(0,'utf8'));
if(!['runtime','migrate','seed','provision','wrongSupplementEntry','wrongDescriptor'].includes(x.kind))throw Error('us_hosted_admin_regression_preparation_failed');
if(x.kind==='runtime') {
  for(const service of ['api','worker'])fs.writeFileSync('/app/us-synthetic-'+service+'.json',JSON.stringify(x.configurations[service])+'\n',{flag:'wx',mode:0o444});
} else {
  if(x.kind==='wrongSupplementEntry') {
    const supplement=JSON.parse(fs.readFileSync('/app/us-synthetic-admin-release.json','utf8'));
    supplement.entrypoint.byteSize++;
    fs.writeFileSync('/app/us-synthetic-admin-release.json',JSON.stringify(supplement)+'\n');
  }
  if(x.kind==='wrongDescriptor')fs.appendFileSync('/app/apps/api/dist/us-request-build.json',' ');
  x.config.release.adminManifestSha256=crypto.createHash('sha256').update(fs.readFileSync('/app/us-synthetic-admin-release.json')).digest('hex');
  fs.writeFileSync('/app/us-synthetic-admin.json',JSON.stringify(x.config)+'\n',{flag:'wx',mode:0o444});
}
function protect(path) {
  const stat=fs.lstatSync(path);
  if(stat.isSymbolicLink()){fs.lchownSync(path,0,0);return;}
  if(stat.isDirectory()){for(const name of fs.readdirSync(path))protect(path+'/'+name);fs.chownSync(path,0,0);fs.chmodSync(path,0o555);}
  else if(stat.isFile()){fs.chownSync(path,0,0);fs.chmodSync(path,0o444);}
  else throw Error('us_hosted_admin_regression_preparation_failed');
}
protect('/app');process.stdout.write('[1]\n');
`;

export const administrativeRegressionMaterialProgram = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto');
if(process.getuid()!==0)throw Error('us_hosted_admin_regression_material_failed');
const x=JSON.parse(fs.readFileSync(0,'utf8'));
if(!['api','worker'].includes(x.service))throw Error('us_hosted_admin_regression_material_failed');
const root='/run/secrets/us-demo';fs.mkdirSync(root,{recursive:true});fs.chownSync(root,0,0);fs.chmodSync(root,0o755);
const values={'db-ca.pem':x.ca,'storage-ca.pem':x.ca,
  [x.service+'-db-password']:crypto.randomBytes(32).toString('hex'),
  [x.service+'-storage-access-key']:crypto.randomBytes(24).toString('hex'),
  [x.service+'-storage-secret-key']:crypto.randomBytes(48).toString('hex')};
if(x.service==='api'){values['api-auth-secret']=crypto.randomBytes(48).toString('hex');values['api-cert.pem']=x.certificate;values['api-key.pem']=x.key;}
for(const [name,value] of Object.entries(values)) {
  if(typeof value!=='string'||!value)throw Error('us_hosted_admin_regression_material_failed');
  const path=root+'/'+name;fs.writeFileSync(path,value.endsWith('\n')?value:value+'\n',{flag:'wx',mode:0o440});
  fs.chownSync(path,0,10001);fs.chmodSync(path,0o440);
}
process.stdout.write('[1]\n');
`;

const regressionOwners = new WeakMap();
function assertRegressionContainer(holder, observed) {
  if (
    !holder ||
    Object.keys(holder).length !== 2 ||
    !/^[a-f0-9]{64}$/.test(holder.containerId) ||
    !/^us-hosted-complete-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(holder.owner) ||
    observed !== holder.owner
  )
    throw invalid();
}
async function regressionContainerOwned(holder, run) {
  assertRegressionContainer(
    holder,
    (
      await run([
        "inspect",
        "--format",
        '{{index .Config.Labels "us-fixture-owner"}}',
        holder.containerId,
      ])
    ).trim(),
  );
}
async function closeRegressionContainer(holder, run) {
  await regressionContainerOwned(holder, run);
  assertAdministrativeHolderSettled(
    await run([
      "exec",
      "--user",
      "10001:10001",
      holder.containerId,
      "node",
      "-e",
      administrativeHolderProcessProgram,
    ]),
  );
  await run(["stop", "--time", "2", holder.containerId]);
  if (
    (await run(["inspect", "--format", "{{.State.ExitCode}}", holder.containerId])).trim() !== "0"
  )
    throw invalid();
  await regressionContainerOwned(holder, run);
  await run(["rm", holder.containerId]);
  if (
    (
      await run([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        "id=" + holder.containerId,
        "--format",
        "{{.ID}}",
      ])
    ).trim()
  )
    throw invalid();
  return { ...holder, absent: true };
}

export function administrativeRegressionHolderSecurity(service) {
  if (
    ![
      "api",
      "worker",
      "migrate",
      "seed",
      "provision",
      "wrongSupplementEntry",
      "wrongDescriptor",
    ].includes(service)
  )
    throw invalid();
  return Object.freeze([
    "--cap-drop=ALL",
    ...(["api", "worker"].includes(service) ? ["--cap-add=CHOWN"] : []),
    "--security-opt=no-new-privileges",
  ]);
}
export const administrativeRegressionRuntimeBootstrap = Object.freeze([
  "/usr/bin/setpriv",
  "--ambient-caps=-all",
  "--inh-caps=-all",
  "node",
]);
export const administrativeRegressionHolderPrivilegeProgram = String.raw`
const status=require('node:fs').readFileSync('/proc/1/status','utf8');
const fields=Object.fromEntries(status.split('\n').filter(line=>line.includes(':')).map(line=>{const at=line.indexOf(':');return [line.slice(0,at),line.slice(at+1).trim()];}));
for(const key of ['Uid','Gid']) {
  const values=(fields[key]||'').split(/\s+/);
  if(values.length!==4||values.some(value=>value!=='10001'))throw Error('us_hosted_admin_fixture_invalid');
}
if(['CapInh','CapPrm','CapEff','CapAmb'].some(key=>!/^0+$/.test(fields[key]||''))||!/^0*1$/.test(fields.CapBnd||'')||fields.NoNewPrivs!=='1')throw Error('us_hosted_admin_fixture_invalid');
process.stdout.write('[1]\n');
`;

export async function prepareAdministrativeRegressionTopology(nativeOwner, persist) {
  const original = administrativeTopologyOwners.get(nativeOwner);
  if (
    !original ||
    !original.closed ||
    original.state.protocolOnly ||
    original.closureProof?.privatePkiDeleted !== true ||
    typeof persist !== "function"
  )
    throw invalid();
  const { selected, root } = original;
  const directory = dirname(selected.source);
  const folder = resolve(root, ".superpowers/sdd/2026-10-22-us-11-demo-viewer/installed-fixtures");
  const paths = [resolve(folder, "current.json"), resolve(folder, "admin-current.json")];
  const archives = [
    resolve(directory, "runtime-regression-closed-receipt.json"),
    resolve(directory, "admin-regression-closed-receipt.json"),
  ];
  const handle = Object.freeze({ purpose: "synthetic-test-only", fixtureSha: selected.fixtureSha });
  const state = {
    schemaVersion: 1,
    purpose: "synthetic-test-only",
    fixtureSha: selected.fixtureSha,
    phase: "initial",
    groups: {},
  };
  const record = {
    state,
    selected,
    root,
    client: createAdministrativeDockerClient(),
    pki: null,
    prepared: false,
    closePromise: null,
    paths,
    archives,
    receiptBytes: [],
  };
  regressionOwners.set(handle, record);
  const save = async (phase) => {
    state.phase = phase;
    await persist(structuredClone(state));
  };
  const run = record.client.run;
  async function create(group, prepare, service) {
    if (
      (
        await run([
          "volume",
          "inspect",
          "--format",
          '{{index .Labels "us-fixture-owner"}}',
          group.volume,
        ])
      ).trim() !== group.owner
    )
      throw invalid();
    const owner =
      prepare || (service !== "api" && service !== "worker")
        ? group.owner
        : "us-hosted-complete-" + randomUUID();
    const args = [
      "create",
      "--pull=never",
      "--name",
      owner + (prepare ? "-prepare" : "-holder"),
      "--label",
      "us-fixture-owner=" + owner,
      "--network=none",
      "--read-only",
      "--user",
      prepare ? "0:0" : "10001:10001",
      "--mount",
      "type=volume,src=" + group.volume + ",dst=/app" + (prepare ? "" : ",readonly"),
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,mode=0700",
    ];
    if (!prepare) args.push(...administrativeRegressionHolderSecurity(service));
    if (!prepare && ["api", "worker"].includes(service))
      args.push("--tmpfs", "/run/secrets/us-demo:rw,nosuid,nodev,noexec,mode=0755");
    args.push(
      administrativeNodeImage,
      ...(!prepare && ["api", "worker"].includes(service)
        ? administrativeRegressionRuntimeBootstrap
        : ["node"]),
      "-e",
      "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)",
    );
    await save("regression_container_create_intent");
    const holder = { containerId: (await run(args)).trim(), owner };
    assertRegressionContainer(holder, owner);
    if (prepare) group.preparer = holder;
    else group.holders.push({ service, ...holder });
    await save("regression_container_created");
    await run(["start", holder.containerId]);
    await regressionContainerOwned(holder, run);
    if (
      (
        await run([
          "inspect",
          "--format",
          "{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.NetworkMode}}",
          holder.containerId,
        ])
      ).trim() !==
      (prepare ? "0:0" : "10001:10001") + " true none"
    )
      throw invalid();
    const mounts = JSON.parse(
      await run(["inspect", "--format", "{{json .Mounts}}", holder.containerId]),
    );
    if (
      !Array.isArray(mounts) ||
      mounts.filter(
        (m) =>
          m.Type === "volume" &&
          m.Name === group.volume &&
          m.Destination === "/app" &&
          m.RW === prepare,
      ).length !== 1 ||
      mounts.some((m) =>
        m.Type === "volume"
          ? m.Name !== group.volume
          : m.Type !== "tmpfs" || !["/tmp", "/run/secrets/us-demo"].includes(m.Destination),
      )
    )
      throw invalid();
    return holder;
  }
  try {
    await save("regression_preflight");
    for (const path of [...paths, ...archives]) await administrativeAbsent(path);
    await administrativeLocalPreflight(record.client);
    await save("regression_pki_intent");
    record.pki = await createAdministrativeRegressionPki(selected, root);
    await save("regression_pki_ready");
    for (const kind of [
      "runtime",
      "migrate",
      "seed",
      "provision",
      "wrongSupplementEntry",
      "wrongDescriptor",
    ]) {
      const owner = "us-hosted-complete-" + randomUUID();
      const group = {
        kind,
        owner,
        volume: owner + "-app",
        volumeCreated: false,
        preparer: null,
        preparerClosure: null,
        holders: [],
      };
      state.groups[kind] = group;
      if (
        (
          await run([
            "volume",
            "ls",
            "--filter",
            "name=^" + group.volume + "$",
            "--format",
            "{{.Name}}",
          ])
        ).trim()
      )
        throw invalid();
      await save("regression_volume_create_intent");
      if (
        (
          await run(["volume", "create", "--label", "us-fixture-owner=" + owner, group.volume])
        ).trim() !== group.volume
      )
        throw invalid();
      group.volumeCreated = true;
      await save("regression_volume_created");
      const preparer = await create(group, true, null);
      await save("regression_package_copy_intent");
      const started = performance.now();
      await run([
        "cp",
        resolve(selected.source, ".superpowers/us-hosted-package/app") + "/.",
        preparer.containerId + ":/app",
      ]);
      group.copyEvidence = {
        actualClientSettled: true,
        exitCode: 0,
        deadlineSeconds: 90,
        elapsedMilliseconds: performance.now() - started,
      };
      const configuration =
        kind === "runtime"
          ? {
              configurations: {
                api: administrativeRegressionRuntimeConfiguration(selected, "api"),
                worker: administrativeRegressionRuntimeConfiguration(selected, "worker"),
              },
            }
          : {
              config: administrativeConfiguration(
                selected,
                ["migrate", "seed", "provision"].includes(kind) ? kind : "migrate",
              ),
            };
      const payload = Buffer.from(JSON.stringify({ kind, ...configuration }));
      try {
        await save("regression_package_protection");
        if (
          (
            await run(
              [
                "exec",
                "-i",
                "--user",
                "0:0",
                preparer.containerId,
                "node",
                "-e",
                administrativeRegressionPackageProgram,
              ],
              payload,
            )
          ).trim() !== "[1]"
        )
          throw invalid();
      } finally {
        payload.fill(0);
      }
      group.preparerClosure = await closeRegressionContainer(preparer, run);
      await save("regression_preparer_closed");
      for (const service of kind === "runtime" ? ["api", "worker"] : [kind]) {
        const holder = await create(group, false, service);
        if (kind === "runtime") {
          const assertRuntimePrivilege = async () => {
            if (
              (
                await run([
                  "exec",
                  "--user",
                  "10001:10001",
                  holder.containerId,
                  "node",
                  "-e",
                  administrativeRegressionHolderPrivilegeProgram,
                ])
              ).trim() !== "[1]"
            )
              throw invalid();
          };
          await assertRuntimePrivilege();
          const material = administrativeRegressionPkiMaterial(record.pki);
          const values = {
            service,
            ca: material.ca,
            ...(service === "api" ? { certificate: material.certificate, key: material.key } : {}),
          };
          const input = Buffer.from(JSON.stringify(values));
          try {
            await save("regression_material_preparation");
            if (
              (
                await run(
                  [
                    "exec",
                    "-i",
                    "--user",
                    "0:0",
                    holder.containerId,
                    "node",
                    "-e",
                    administrativeRegressionMaterialProgram,
                  ],
                  input,
                )
              ).trim() !== "[1]"
            )
              throw invalid();
          } finally {
            input.fill(0);
          }
          await assertRuntimePrivilege();
        }
      }
    }
    const common = {
      schemaVersion: 1,
      purpose: "synthetic-test-only",
      baseSha: selected.baseSha,
      patchSha256: selected.patchSha256,
      fixtureSha: selected.fixtureSha,
      manifestSha256: selected.manifestSha256,
    };
    const owned = (kind) => {
      const { containerId, owner } = state.groups[kind].holders[0];
      return { containerId, owner };
    };
    const services = {};
    for (const { service, containerId, owner } of state.groups.runtime.holders)
      services[service] = { containerId, owner };
    const documents = [
      { ...common, services },
      {
        ...common,
        adminManifestSha256: selected.adminManifestSha256,
        operations: {
          migrate: owned("migrate"),
          seed: owned("seed"),
          provision: owned("provision"),
        },
        variants: {
          wrongSupplementEntry: owned("wrongSupplementEntry"),
          wrongDescriptor: owned("wrongDescriptor"),
        },
      },
    ];
    for (let index = 0; index < documents.length; index++) {
      const bytes = Buffer.from(JSON.stringify(documents[index]) + "\n");
      if (bytes.length > 16384) throw invalid();
      record.receiptBytes.push(bytes);
      await save("regression_receipt_write_intent");
      await writeFile(paths[index], bytes, { flag: "wx", mode: 0o600 });
    }
    record.prepared = true;
    await save("regression_prepared_for_actual_tests");
    return handle;
  } catch (error) {
    if (error?.pkiOwner) record.pki = error.pkiOwner;
    state.failurePhase = state.phase;
    try {
      await save("regression_failed_owned_state_retained");
    } catch {
      /* Retain owner in memory if persistence itself failed. */
    }
    const failure = new Error("us_hosted_admin_regression_failed");
    failure.regressionOwner = handle;
    throw failure;
  }
}
export function inspectAdministrativeRegressionTopology(handle) {
  const record = regressionOwners.get(handle);
  if (!record) throw invalid();
  return structuredClone(record.state);
}
export function closeAdministrativeRegressionTopology(handle, persist) {
  const record = regressionOwners.get(handle);
  if (!record || !record.prepared || typeof persist !== "function")
    return Promise.reject(invalid());
  if (record.closePromise) return record.closePromise;
  record.closePromise = (async () => {
    const run = record.client.run,
      state = record.state;
    const save = async (phase) => {
      state.phase = phase;
      await persist(structuredClone(state));
    };
    await record.client.settle();
    for (let index = 0; index < record.paths.length; index++) {
      const file = await administrativeCapturedFile(record.paths[index], 16384);
      try {
        if (file.sha256 !== administrativeSha(record.receiptBytes[index])) throw invalid();
      } finally {
        file.metadata.fill(0);
      }
    }
    let containers = 0,
      volumes = 0;
    for (const group of Object.values(state.groups)) {
      if (group.preparerClosure?.absent !== true) throw invalid();
      group.holderClosures = [];
      for (const { containerId, owner } of group.holders) {
        await save("regression_holder_normal_close");
        group.holderClosures.push(await closeRegressionContainer({ containerId, owner }, run));
        containers++;
      }
      await save("regression_volume_normal_close");
      if (
        (
          await run([
            "volume",
            "inspect",
            "--format",
            '{{index .Labels "us-fixture-owner"}}',
            group.volume,
          ])
        ).trim() !== group.owner ||
        (
          await run([
            "container",
            "ls",
            "--all",
            "--filter",
            "volume=" + group.volume,
            "--format",
            "{{.ID}}",
          ])
        ).trim()
      )
        throw invalid();
      await run(["volume", "rm", group.volume]);
      if (
        (
          await run([
            "volume",
            "ls",
            "--filter",
            "name=^" + group.volume + "$",
            "--format",
            "{{.Name}}",
          ])
        ).trim()
      )
        throw invalid();
      group.volumeAbsent = true;
      volumes++;
      await save("regression_volume_absent");
    }
    if (containers !== 7 || volumes !== 6) throw invalid();
    await save("regression_pki_normal_delete");
    state.pkiClosure = await disposeAdministrativePki(record.pki);
    if (state.pkiClosure.privatePkiDeleted !== true || state.pkiClosure.ownedFilesRemoved !== 8)
      throw invalid();
    for (let index = 0; index < record.paths.length; index++) {
      await administrativeAbsent(record.archives[index]);
      await save("regression_receipt_archive");
      await writeFile(record.archives[index], record.receiptBytes[index], {
        flag: "wx",
        mode: 0o600,
      });
      await unlink(record.paths[index]);
    }
    state.closureProof = {
      purpose: "synthetic-test-only",
      removedHolders: containers,
      removedVolumes: volumes,
      privatePkiDeleted: true,
      receiptsArchived: 2,
    };
    await save("regression_closed_normally");
    return Object.freeze(state.closureProof);
  })();
  return record.closePromise;
}

export function assertAdministrativeNativeReport(report, mode, exitCode) {
  const fail = () => {
    throw new Error("us_hosted_admin_native_report_invalid");
  };
  if (
    !["native-green", "native-green-restored", "ca-red", "name-red", "regression-green"].includes(
      mode,
    ) ||
    !report
  )
    fail();
  const red = mode === "ca-red" || mode === "name-red",
    count = mode === "regression-green" ? 33 : 19;
  if (
    exitCode !== (red ? 1 : 0) ||
    report.success !== !red ||
    report.numTotalTests !== count ||
    report.numPassedTests !== (red ? 0 : count) ||
    report.numFailedTests !== (red ? 1 : 0) ||
    report.numPendingTests !== (red ? 18 : 0) ||
    report.numTodoTests !== 0 ||
    !Array.isArray(report.testResults) ||
    report.testResults.length !== 1
  )
    fail();
  const file = report.testResults[0],
    name =
      mode === "regression-green"
        ? "us-hosted-installed-entry.e2e.test.ts"
        : "us-hosted-admin-preflight-installed.e2e.test.ts";
  if (
    typeof file.name !== "string" ||
    !file.name.endsWith("/test/" + name) ||
    file.message !== "" ||
    file.status !== (red ? "failed" : "passed") ||
    !Array.isArray(file.assertionResults) ||
    file.assertionResults.length !== count
  )
    fail();
  const rows = file.assertionResults;
  if (
    rows.filter((row) => row.status === "passed").length !== (red ? 0 : count) ||
    rows.filter((row) => row.status === "failed").length !== (red ? 1 : 0) ||
    rows.filter((row) => row.status === "skipped").length !== (red ? 18 : 0)
  )
    fail();
  if (red) {
    const selected = rows.find((row) => row.status === "failed");
    const title =
      "refuses the actual " + (mode === "ca-red" ? "wrongCA" : "wrongName") + " database peer";
    if (
      selected.title !== title ||
      !Array.isArray(selected.failureMessages) ||
      selected.failureMessages.some((message) => typeof message !== "string")
    )
      fail();
    const message = stripVTControlCharacters(selected.failureMessages.join("\n"));
    if (
      !/AssertionError:\s*expected\s*\[\s*\+?0\s*,\s*\+?0\s*,\s*1\s*\]\s*to deeply equal\s*\[\s*1\s*,\s*1\s*,\s*1\s*\]/.test(
        message,
      ) ||
      /timed?\s*out|TimeoutError|5000ms/i.test(message)
    )
      fail();
  }
  return Object.freeze({
    mode,
    total: count,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    pending: report.numPendingTests,
    exitCode,
  });
}

export function assertAdministrativePostgresNetwork(document, expected, started) {
  try {
    namedAdministrativeResource({ name: expected.name, owner: expected.owner }, "network");
    if (
      typeof expected.id !== "string" ||
      !/^[a-f0-9]{64}$/.test(expected.id) ||
      typeof started !== "boolean" ||
      typeof document !== "string" ||
      Buffer.byteLength(document) > 65536
    )
      throw invalid();
    const networks = JSON.parse(document);
    if (
      !networks ||
      typeof networks !== "object" ||
      Array.isArray(networks) ||
      Object.keys(networks).length !== 1 ||
      !Object.hasOwn(networks, expected.name)
    )
      throw invalid();
    const endpoint = networks[expected.name];
    if (
      !endpoint ||
      typeof endpoint !== "object" ||
      Array.isArray(endpoint) ||
      !(endpoint.NetworkID === expected.id || (!started && endpoint.NetworkID === "")) ||
      !Array.isArray(endpoint.Aliases) ||
      !endpoint.Aliases.includes("postgres.us-demo.internal")
    )
      throw invalid();
  } catch {
    throw invalid();
  }
}

export function assertAdministrativeHolderNetwork(document, expected) {
  try {
    namedAdministrativeResource({ name: expected.name, owner: expected.owner }, "network");
    if (
      typeof expected.id !== "string" ||
      !/^[a-f0-9]{64}$/.test(expected.id) ||
      typeof document !== "string" ||
      Buffer.byteLength(document) > 65536
    )
      throw invalid();
    const networks = JSON.parse(document);
    if (
      !networks ||
      typeof networks !== "object" ||
      Array.isArray(networks) ||
      Object.keys(networks).length !== 1 ||
      !Object.hasOwn(networks, expected.name)
    )
      throw invalid();
    const endpoint = networks[expected.name];
    if (
      !endpoint ||
      typeof endpoint !== "object" ||
      Array.isArray(endpoint) ||
      endpoint.NetworkID !== expected.id
    )
      throw invalid();
  } catch {
    throw invalid();
  }
}

const administrativeNativePhases = new Set([
  "host_dispatch",
  "host_first_guest_marker",
  "host_completed_ok",
  "host_completed_error",
  "guest_started",
  "modules_loaded",
  "release_begin",
  "release_end",
  "material_begin",
  "material_end",
  "connection_begin",
  "connection_settled",
  "pool_end_begin",
  "pool_end_end",
  "disposal_complete",
]);
export function parseAdministrativeNativePhase(line) {
  if (
    typeof line !== "string" ||
    Buffer.byteLength(line) > 512 ||
    !line.startsWith("US_ADMIN_PHASE ")
  )
    return undefined;
  try {
    const value = JSON.parse(line.slice("US_ADMIN_PHASE ".length));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "phase") ||
      !Object.hasOwn(value, "elapsedMs") ||
      !administrativeNativePhases.has(value.phase) ||
      typeof value.elapsedMs !== "number" ||
      !Number.isFinite(value.elapsedMs) ||
      value.elapsedMs < 0 ||
      value.elapsedMs > 30000
    )
      return undefined;
    return Object.freeze({ phase: value.phase, elapsedMs: value.elapsedMs });
  } catch {
    return undefined;
  }
}
