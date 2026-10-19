import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";

const read = (path) => readFileSync(path, "utf8");

test("compact runtime budgets two CPUs and 2752 MiB while migration is a separate phase", () => {
  const { services: s } = load(read("deploy/platform/compose.compact.yml"));
  assert.equal(s.api.mem_limit, "1536m");
  assert.equal(s.api.environment.NODE_OPTIONS, "--max-old-space-size=1024");
  assert.equal(s.api.cpus, 1.25);
  assert.equal(s.api.environment.PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA, "true");
  assert.equal(s.migrate.environment.PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA, undefined);
  assert.equal(s.postgres.mem_limit, "1024m");
  assert.equal(s.postgres.cpus, 0.5);
  assert.equal(s.edge.mem_limit, "192m");
  assert.equal(s.edge.cpus, 0.25);
  assert.equal(s.migrate.mem_limit, "512m");
  assert.equal(s.migrate.cpus, 1.5);
  assert.deepEqual(s.migrate.depends_on, { postgres: { condition: "service_healthy" } });
  for (const svc of Object.values(s)) {
    assert.equal(svc.logging.driver, "json-file");
    assert.deepEqual(svc.logging.options, { "max-size": "10m", "max-file": "3" });
  }
});

test("local PostgreSQL persists data on a private network and requires verified TLS", () => {
  const c = load(read("deploy/platform/compose.compact.yml"));
  const pg = c.services.postgres;
  assert.match(pg.image, /postgres:17-alpine@\$\{MARKIRO_POSTGRES_IMAGE_DIGEST:\?/);
  assert.equal(pg.ports, undefined);
  assert.deepEqual(Object.keys(pg.networks), ["database"]);
  assert.deepEqual(pg.networks.database.aliases, ["db.private"]);
  assert.equal(c.networks.database.internal, true);
  assert.ok(pg.volumes.some((v) => v === "postgres-data:/var/lib/postgresql/data"));
  assert.ok(pg.command.includes("ssl=on"));
  assert.ok(pg.command.includes("max_connections=32"));
  assert.ok(pg.command.includes("shared_buffers=256MB"));
  assert.ok(pg.command.includes("fsync=on"));
  assert.ok(pg.command.includes("full_page_writes=on"));
  assert.ok(pg.command.includes("synchronous_commit=on"));
  for (const key of ["api", "migrate"]) {
    assert.deepEqual(c.services[key].networks, ["default", "database"]);
    assert.ok(
      c.services[key].volumes.some(
        (v) => v.target === "/run/markiro-postgres/ca.crt" && v.read_only,
      ),
    );
  }
  for (const target of ["server.crt", "server.key"]) {
    const mount = pg.volumes.find((v) => v.target === `/run/markiro-postgres/${target}`);
    assert.equal(mount.read_only, true);
    assert.equal(mount.bind.create_host_path, false);
  }
  const hba = read("deploy/platform/postgres/pg_hba.conf");
  assert.match(hba, /hostnossl\s+all\s+all\s+all\s+reject/);
  assert.match(hba, /hostssl\s+all\s+all\s+all\s+scram-sha-256/);
  assert.doesNotMatch(hba, /trust/);
  assert.equal(
    c.services.postgres.environment.POSTGRES_INITDB_ARGS,
    "--auth-host=scram-sha-256 --auth-local=peer",
  );
});

test("PostgreSQL health waits for final TCP listener instead of the socket-only init server", () => {
  const c = load(read("deploy/platform/compose.compact.yml"));
  assert.deepEqual(c.services.postgres.healthcheck.test, [
    "CMD",
    "pg_isready",
    "-h",
    "127.0.0.1",
    "-U",
    "postgres",
    "-d",
    "markiro",
  ]);
});
