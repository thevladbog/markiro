import { randomUUID } from "node:crypto";
import { canonical, ensure } from "../backup/schemas.mjs";
import { validateIdentity, snapshot } from "./state-validation.mjs";
import { createPrivateDirectory, writePrivateFile } from "./files.mjs";
import { createDockerCommand } from "./observe.mjs";
import { runHostArchiveProcess } from "./process.mjs";
import { buildProductMigrationProof } from "./forward-ledger.mjs";
import { carryHostFailure } from "./failure-diagnostic.mjs";
const archiveLimit = 16 * 1024 * 1024;
const fileLimit = 2 * 1024 * 1024;
function tarText(header, start, size) {
  const bytes = header.subarray(start, start + size);
  const end = bytes.indexOf(0);
  const used = end === -1 ? bytes : bytes.subarray(0, end);
  ensure([...used].every((b) => b >= 32 && b <= 126));
  if (end !== -1) ensure(bytes.subarray(end).every((b) => b === 0));
  return used.toString("ascii");
}
function octal(header, start, size) {
  const text = header.subarray(start, start + size).toString("ascii");
  ensure(/^[0-7]+[\0 ]*$/u.test(text));
  const value = Number.parseInt(text, 8);
  ensure(Number.isSafeInteger(value) && value >= 0);
  return value;
}
export function readProductMigrationTar(bytes) {
  ensure(
    Buffer.isBuffer(bytes) &&
      bytes.length >= 1024 &&
      bytes.length <= archiveLimit &&
      bytes.length % 512 === 0,
  );
  const files = [];
  const paths = new Set();
  let total = 0;
  for (let offset = 0; offset < bytes.length;) {
    const h = bytes.subarray(offset, offset + 512);
    if (h.every((b) => b === 0)) {
      ensure(
        offset + 1024 <= bytes.length &&
          bytes.subarray(offset).every((b) => b === 0) &&
          files.length > 0,
      );
      return files;
    }
    const checksum = [...h].reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0);
    ensure(octal(h, 148, 8) === checksum && ["ustar", "ustar "].includes(tarText(h, 257, 6)));
    const prefix = tarText(h, 345, 155),
      name = tarText(h, 0, 100);
    const path = prefix ? `${prefix}/${name}` : name;
    ensure(
      path && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\"),
    );
    const size = octal(h, 124, 12),
      type = h[156];
    offset += 512;
    ensure(size <= fileLimit && offset + size <= bytes.length);
    if (type === 53) {
      // Docker archives contain these structural directories; no directory or
      // archive entry is ever extracted to the filesystem.
      ensure(
        size === 0 && ["migrations/", "migrations/meta/", "./", "./meta/", "meta/"].includes(path),
      );
    } else {
      ensure([0, 48].includes(type) && size > 0);
      const relative = path.startsWith("migrations/")
        ? path.slice(11)
        : path.startsWith("./")
          ? path.slice(2)
          : path;
      ensure(
        (relative === "meta/_journal.json" || /^[0-9]{4}_[a-z0-9_]{1,100}\.sql$/u.test(relative)) &&
          !paths.has(relative),
      );
      paths.add(relative);
      total += size;
      ensure(total <= archiveLimit && files.length < 4097);
      files.push({ path: relative, bytes: Buffer.from(bytes.subarray(offset, offset + size)) });
    }
    const end = offset + Math.ceil(size / 512) * 512;
    ensure(end <= bytes.length && bytes.subarray(offset + size, end).every((b) => b === 0));
    offset = end;
  }
  ensure(false);
}
export async function extractProductMigrationProof(input) {
  let created = false,
    removed = false,
    cleanupAttempted = false,
    containerId;
  const identity = snapshot(input.identity);
  validateIdentity(identity);
  const { root, verifySources } = input;
  ensure(typeof verifySources === "function");
  const selected = identity.admission.registry.api;
  ensure(selected.reference === identity.admission.manifest.api);
  const name = `markiro-platform-product-${identity.operationId}-${randomUUID()}`;
  const command = createDockerCommand({ root, dockerConfig: `${root}/docker` }, input.runProcess);
  const one = async (kind, selector) => {
    const rows = JSON.parse(String((await command([kind, "inspect", selector])).stdout));
    ensure(Array.isArray(rows) && rows.length === 1);
    return rows[0];
  };
  const inspectImage = async () => {
    const image = await one("image", selected.reference);
    ensure(
      image.Id === selected.imageId &&
        image.Os === "linux" &&
        image.Architecture === "amd64" &&
        Array.isArray(image.RepoDigests) &&
        image.RepoDigests.includes(selected.reference) &&
        Object.keys(image.Config?.Volumes ?? {}).length === 0,
    );
  };
  const inspectOwned = async () => {
    ensure(typeof containerId === "string" && /^[a-f0-9]{64}$/u.test(containerId));
    const c = await one("container", containerId);
    ensure(
      c.Id === containerId &&
        c.Name === `/${name}` &&
        c.Image === selected.imageId &&
        c.Config.Image === selected.reference &&
        c.Config.Labels["io.markiro.operation"] === identity.operationId &&
        c.Config.Labels["io.markiro.purpose"] === "product-migrations" &&
        c.Config.Labels["io.markiro.extraction"] === name,
    );
    ensure(
      c.State.Status === "created" &&
        c.State.StartedAt === "0001-01-01T00:00:00Z" &&
        c.State.Running === false &&
        c.State.Paused === false &&
        c.State.Restarting === false &&
        Array.isArray(c.Mounts) &&
        c.Mounts.length === 0,
    );
    ensure(
      c.HostConfig.NetworkMode === "none" &&
        c.HostConfig.ReadonlyRootfs === true &&
        c.HostConfig.Privileged === false &&
        canonical(c.HostConfig.CapDrop) === canonical(["ALL"]) &&
        canonical(c.HostConfig.SecurityOpt) === canonical(["no-new-privileges:true"]) &&
        c.HostConfig.LogConfig.Type === "none" &&
        canonical(c.Config.Entrypoint) === canonical(["/bin/false"]) &&
        (c.Config.Cmd == null || canonical(c.Config.Cmd) === canonical([])),
    );
  };
  const cleanup = async () => {
    ensure(!cleanupAttempted);
    cleanupAttempted = true;
    await verifySources();
    await inspectImage();
    await inspectOwned();
    await command(["container", "rm", containerId]);
    const result = await command([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `name=^/${name}$`,
    ]);
    ensure(String(result.stdout).trim() === "");
    removed = true;
    await verifySources();
  };
  try {
    await verifySources();
    await inspectImage();
    // Set the latch before create: an unconfirmed create is never retried or
    // cleaned by name, since it may have created a container without returning ID.
    created = true;
    containerId = String(
      (
        await command([
          "create",
          "--name",
          name,
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--log-driver",
          "none",
          "--entrypoint",
          "/bin/false",
          "--label",
          `io.markiro.operation=${identity.operationId}`,
          "--label",
          "io.markiro.purpose=product-migrations",
          "--label",
          `io.markiro.extraction=${name}`,
          selected.reference,
        ])
      ).stdout,
    ).trim();
    await verifySources();
    await inspectOwned();
    const request = {
      executable: "/usr/bin/docker",
      args: [
        "--host",
        "unix:///var/run/docker.sock",
        "cp",
        `${containerId}:/app/node_modules/@markiro/db/migrations/.`,
        "-",
      ],
      cwd: root,
      env: {
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        LANG: "C.UTF-8",
        DOCKER_CONFIG: `${root}/docker`,
      },
      timeoutMs: 60000,
      outputLimitBytes: archiveLimit,
    };
    const result = await (input.runProcess ?? runHostArchiveProcess)(request);
    await verifySources();
    await inspectImage();
    await inspectOwned();
    const proof = buildProductMigrationProof({
      productSha: identity.admission.manifest.sourceSha,
      imageId: selected.imageId,
      imageReference: selected.reference,
      files: readProductMigrationTar(result.stdout),
    });
    await createPrivateDirectory(root, "product-migration-proofs", { exclusive: false });
    await writePrivateFile(
      root,
      `product-migration-proofs/${name}.json`,
      Buffer.from(`${canonical(proof)}\n`),
    );
    await cleanup();
    return proof;
  } catch (error) {
    const uncertain = error?.terminationConfirmed === false || error?.durabilityUncertain === true;
    let cleanupFailed = false;
    if (created && !removed && !uncertain && !cleanupAttempted) {
      try {
        await cleanup();
      } catch {
        cleanupFailed = true;
      }
    }
    const failure = carryHostFailure(
      error,
      new Error("Pinned product migration extraction failed."),
    );
    failure.code = "ERR_HOST_FORWARD_PRODUCT";
    if (uncertain || cleanupFailed || (created && !removed)) failure.durabilityUncertain = true;
    throw failure;
  }
}
