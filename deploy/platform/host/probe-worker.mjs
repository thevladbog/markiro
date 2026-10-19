/** Fixed one-shot worker; only read-only SQL. No arguments, SQL, code or env supplied by JSON. */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash, X509Certificate } from "node:crypto";
import { checkServerIdentity } from "node:tls";
import { pathToFileURL } from "node:url";

const require = createRequire("/app/node_modules/@markiro/db/package.json");
const ensure = (ok) => {
  if (!ok) throw new Error("PostgreSQL host probe rejected.");
};
export async function probePostgres({ Client, input, ca }) {
  ensure(Object.keys(input).sort().join() === "appUrl,migrationUrl");
  const urls = [new URL(input.appUrl), new URL(input.migrationUrl)];
  ensure(urls[0].username === "markiro_app" && urls[1].username === "markiro_migrator");
  for (const u of urls) {
    ensure(
      u.protocol === "postgresql:" &&
        u.hostname === "db.private" &&
        (!u.port || u.port === "5432") &&
        u.pathname === "/markiro" &&
        u.searchParams.get("sslmode") === "verify-full",
    );
    u.search = "";
  }
  let observed;
  for (const [index, u] of urls.entries()) {
    for (const mode of ["valid", "wrong-host", "untrusted", "plaintext"]) {
      const client = new Client({
        connectionString: u.href,
        application_name: "markiro_host_probe",
        connectionTimeoutMillis: 5000,
        statement_timeout: 5000,
        query_timeout: 6000,
        options: "-c default_transaction_read_only=on",
        ssl:
          mode === "plaintext"
            ? false
            : {
                rejectUnauthorized: true,
                ca: mode === "untrusted" ? [] : ca,
                ...(mode === "wrong-host"
                  ? {
                      checkServerIdentity: (_host, certificate) =>
                        checkServerIdentity("host-probe.invalid", certificate),
                    }
                  : {}),
              },
      });
      try {
        let connected = false;
        try {
          await client.connect();
          connected = true;
        } catch (error) {
          const codes =
            mode === "plaintext"
              ? ["28000"]
              : mode === "wrong-host"
                ? ["ERR_TLS_CERT_ALTNAME_INVALID"]
                : mode === "untrusted"
                  ? [
                      "SELF_SIGNED_CERT_IN_CHAIN",
                      "DEPTH_ZERO_SELF_SIGNED_CERT",
                      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
                      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
                    ]
                  : [];
          ensure(codes.includes(error.code));
        }
        ensure(connected === (mode === "valid"));
        if (!connected) continue;
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        ensure(
          (await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only === "on",
        );
        const tls = (await client.query("SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()"))
          .rows;
        ensure(tls.length === 1 && tls[0].ssl === true);
        const cert = new X509Certificate(client.connection.stream.getPeerCertificate(true).raw);
        ensure(cert.checkHost("db.private") === "db.private");
        const version = (await client.query("SHOW server_version")).rows[0].server_version;
        ensure(/^17\.[0-9]+(?: |$)/u.test(version));
        const value = {
          postgresVersion: version,
          tls: {
            certificateSha256: createHash("sha256").update(cert.raw).digest("hex"),
            san: "db.private",
            notBefore: new Date(cert.validFrom).toISOString(),
            expiresAt: new Date(cert.validTo).toISOString(),
          },
        };
        if (observed) ensure(JSON.stringify(observed) === JSON.stringify(value));
        observed = value;
        if (index === 1) {
          const roles = (
            await client.query(
              "SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname IN ('markiro_app','markiro_migrator') ORDER BY rolname",
            )
          ).rows;
          ensure(roles.length === 2);
          for (const role of roles)
            ensure(
              role.rolcanlogin &&
                [
                  "rolsuper",
                  "rolcreatedb",
                  "rolcreaterole",
                  "rolreplication",
                  "rolbypassrls",
                ].every((k) => role[k] === false),
            );
          ensure(
            (
              await client.query(
                "SELECT count(*)::int AS n FROM pg_auth_members WHERE member IN ('markiro_app'::regrole,'markiro_migrator'::regrole)",
              )
            ).rows[0].n === 0,
          );
          const policy = (
            await client.query(`SELECT
            NOT has_database_privilege('markiro_app',current_database(),'CREATE') AS app_no_create,
            has_database_privilege('markiro_migrator',current_database(),'CREATE') AS migrator_create,
            NOT has_schema_privilege('markiro_app','public','CREATE') AS app_no_public_ddl,
            NOT has_schema_privilege('markiro_app','drizzle','USAGE') AS app_no_journal,
            (SELECT nspowner='markiro_migrator'::regrole FROM pg_namespace WHERE nspname='public') AS public_owner,
            (SELECT nspowner='markiro_migrator'::regrole FROM pg_namespace WHERE nspname='drizzle') AS drizzle_owner,
            (SELECT nspowner='markiro_app'::regrole FROM pg_namespace WHERE nspname='pgboss_platform') AS queue_owner,
            NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p','S','v','m') AND c.relowner <> 'markiro_migrator'::regrole) AS business_owner,
            NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='pgboss' AND has_schema_privilege('markiro_app',oid,'USAGE')) AS legacy_denied,
            NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (NOT (has_table_privilege('markiro_app',c.oid,'SELECT') AND has_table_privilege('markiro_app',c.oid,'INSERT') AND has_table_privilege('markiro_app',c.oid,'UPDATE') AND has_table_privilege('markiro_app',c.oid,'DELETE')) OR has_table_privilege('markiro_app',c.oid,'TRUNCATE'))) AS business_dml
          `)
          ).rows[0];
          ensure(Object.values(policy).every((v) => v === true));
          // Default ACLs must grant each privilege separately, not a partial OR.
          const defaults = (
            await client.query(
              "SELECT d.defaclobjtype AS kind,a.privilege_type AS privilege FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole='markiro_migrator'::regrole AND d.defaclnamespace='public'::regnamespace AND a.grantee='markiro_app'::regrole ORDER BY 1,2",
            )
          ).rows;
          ensure(
            JSON.stringify(defaults) ===
              JSON.stringify([
                { kind: "S", privilege: "SELECT" },
                { kind: "S", privilege: "USAGE" },
                { kind: "r", privilege: "DELETE" },
                { kind: "r", privilege: "INSERT" },
                { kind: "r", privilege: "SELECT" },
                { kind: "r", privilege: "UPDATE" },
              ]),
          );
        }
        await client.query("ROLLBACK");
      } finally {
        await client.end().catch(() => {});
      }
    }
  }
  return observed;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    ensure(process.argv.length === 2);
    const { Client } = require("pg");
    const result = await probePostgres({
      Client,
      input: JSON.parse(await readFile("/input/connections.json", "utf8")),
      ca: await readFile("/input/ca.crt", "utf8"),
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    process.stderr.write("PostgreSQL host probe failed.\n");
    process.exitCode = 1;
  }
}
