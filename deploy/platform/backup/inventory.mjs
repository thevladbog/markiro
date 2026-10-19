import { createHash } from "node:crypto";
import { leastPrivilegeRoleAttributes, leastPrivilegeRoleSql } from "../postgres/roles.mjs";
import {
  canonical,
  ensure,
  keys,
  quote,
  validateInventory,
  identifier,
  digest,
  fail,
  objectKinds,
  privileges,
} from "./schemas.mjs";
const order = (rows) =>
  rows.sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));
const qname = (schema, name) => (schema ? `${quote(schema)}.${quote(name)}` : quote(name));
const roleName = (name) => (name === "PUBLIC" ? "PUBLIC" : quote(name));
const aclSQL = `SELECT pg_get_userbyid(grantor) AS grantor,CASE WHEN grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(grantee) END AS grantee,privilege_type AS privilege,is_grantable AS grantable FROM aclexplode($1::aclitem[])`;
const namespaces = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp'`;
export async function captureInventory(client, { excludeRole } = {}) {
  const rows = async (sql, args = []) => (await client.query(sql, args)).rows;
  ensure((await rows(`SELECT count(*)::int AS n FROM pg_foreign_server`))[0].n === 0);
  for (const catalog of [
    "pg_largeobject_metadata",
    "pg_event_trigger",
    "pg_publication",
    "pg_subscription",
    "pg_policy",
  ])
    ensure((await rows(`SELECT count(*)::int AS n FROM ${catalog}`))[0].n === 0);
  ensure(
    (
      await rows(
        `SELECT count(*)::int AS n FROM pg_roles WHERE rolname !~ '^pg_' AND (rolconfig IS NOT NULL OR rolvaliduntil IS NOT NULL)`,
      )
    )[0].n === 0,
  );
  ensure(
    (
      await rows(
        `SELECT count(*)::int AS n FROM pg_db_role_setting WHERE setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))`,
      )
    )[0].n === 0,
  );
  ensure(
    (
      await rows(
        `SELECT count(*)::int AS n FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE ${namespaces}`,
      )
    )[0].n === 0,
  );
  ensure(
    (
      await rows(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespaces} AND (c.relkind='c' OR c.relrowsecurity OR c.relforcerowsecurity)`,
      )
    )[0].n === 0,
  );
  const roles = await rows(
    `SELECT rolname AS name,rolcanlogin AS login,rolsuper AS superuser,rolcreatedb AS createdb,rolcreaterole AS createrole,rolreplication AS replication,rolbypassrls AS bypassrls,rolinherit AS inherit,rolconnlimit AS "connectionLimit" FROM pg_roles WHERE rolname !~ '^pg_' AND ($1::text IS NULL OR rolname<>$1)`,
    [excludeRole ?? null],
  );
  const memberships = await rows(
    `SELECT pg_get_userbyid(roleid) AS role,pg_get_userbyid(member) AS member,pg_get_userbyid(grantor) AS grantor,admin_option AS admin,inherit_option AS inherit,set_option AS set FROM pg_auth_members WHERE pg_get_userbyid(member) !~ '^pg_'`,
  );
  const objects =
    await rows(`SELECT 'DATABASE' AS kind,'' AS schema,datname AS name,datdba AS owner,coalesce(datacl,acldefault('d',datdba))::text AS acl,'pg_database' AS catalog,oid FROM pg_database WHERE datname=current_database()
 UNION ALL SELECT 'SCHEMA','',nspname,nspowner,coalesce(nspacl,acldefault('n',nspowner))::text,'pg_namespace',oid FROM pg_namespace n WHERE ${namespaces}
 UNION ALL SELECT CASE relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE' ELSE 'UNSUPPORTED' END,n.nspname,c.relname,c.relowner,coalesce(c.relacl,acldefault(CASE WHEN relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))::text,'pg_class',c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespaces} AND c.relkind NOT IN ('i','I','t','c')
 UNION ALL SELECT CASE WHEN p.prokind='p' THEN 'PROCEDURE' WHEN p.prokind='f' THEN 'FUNCTION' ELSE 'UNSUPPORTED' END,n.nspname,p.proname,p.proowner,coalesce(p.proacl,acldefault('f',p.proowner))::text,'pg_proc',p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${namespaces}
 UNION ALL SELECT CASE WHEN t.typtype='d' THEN 'DOMAIN' ELSE 'TYPE' END,n.nspname,t.typname,t.typowner,coalesce(t.typacl,acldefault('T',t.typowner))::text,'pg_type',t.oid FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${namespaces} AND t.typrelid=0 AND t.typelem=0`);
  for (const object of objects) {
    ensure(objectKinds.has(object.kind));
    object.owner = (await rows("SELECT pg_get_userbyid($1) AS name", [object.owner]))[0].name;
    object.acl = order(await rows(aclSQL, [object.acl]));
    if (object.kind === "DATABASE") {
      object.locale = (
        await rows(
          "SELECT pg_encoding_to_char(encoding) AS encoding,datcollate AS collate,datctype AS ctype,datlocprovider AS provider FROM pg_database WHERE datname=current_database()",
        )
      )[0];
      ensure(object.locale.provider === "c");
    }
    object.extension =
      (
        await rows(
          `SELECT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid WHERE d.classid=$1::regclass AND d.objid=$2 AND d.refclassid='pg_extension'::regclass AND d.deptype='e'`,
          [object.catalog, object.oid],
        )
      )[0]?.extname ?? null;
    object.args = ["FUNCTION", "PROCEDURE"].includes(object.kind)
      ? await rows(
          `SELECT n.nspname AS schema,t.typname AS name FROM pg_proc p CROSS JOIN LATERAL unnest(p.proargtypes) WITH ORDINALITY a(oid,ord) JOIN pg_type t ON t.oid=a.oid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE p.oid=$1 ORDER BY a.ord`,
          [object.oid],
        )
      : [];
    if (["FUNCTION", "PROCEDURE"].includes(object.kind))
      object.definitionSha256 = digest(
        (await rows("SELECT pg_get_functiondef($1::oid) AS definition", [object.oid]))[0]
          .definition,
      );
    // Column ACLs require a separate grant model; fail closed rather than lose them.
    if (object.catalog === "pg_class")
      ensure(
        (
          await rows(
            "SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid=$1 AND attacl IS NOT NULL",
            [object.oid],
          )
        )[0].n === 0,
      );
    delete object.catalog;
    delete object.oid;
  }
  const operators =
    await rows(`SELECT 'OPERATOR' AS kind,n.nspname AS schema,o.oprname AS name,pg_get_userbyid(o.oprowner) AS owner,o.oid,'pg_operator' AS catalog FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace WHERE ${namespaces}
 UNION ALL SELECT 'OPERATOR CLASS',n.nspname,o.opcname,pg_get_userbyid(o.opcowner),o.oid,'pg_opclass' FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace WHERE ${namespaces}
 UNION ALL SELECT 'OPERATOR FAMILY',n.nspname,o.opfname,pg_get_userbyid(o.opfowner),o.oid,'pg_opfamily' FROM pg_opfamily o JOIN pg_namespace n ON n.oid=o.opfnamespace WHERE ${namespaces}`);
  for (const o of operators) {
    o.acl = [];
    o.extension =
      (
        await rows(
          `SELECT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid WHERE d.classid=$1::regclass AND d.objid=$2 AND d.refclassid='pg_extension'::regclass AND d.deptype='e'`,
          [o.catalog, o.oid],
        )
      )[0]?.extname ?? null;
    ensure(o.extension === "btree_gist");
    if (o.kind === "OPERATOR")
      o.args = await rows(
        `SELECT n.nspname AS schema,t.typname AS name FROM pg_operator o CROSS JOIN LATERAL unnest(ARRAY[o.oprleft,o.oprright]) WITH ORDINALITY a(oid,ord) LEFT JOIN pg_type t ON t.oid=a.oid LEFT JOIN pg_namespace n ON n.oid=t.typnamespace WHERE o.oid=$1 ORDER BY a.ord`,
        [o.oid],
      );
    else {
      o.args = [];
      o.method = (
        await rows(
          `SELECT am.amname AS name FROM ${o.catalog} o JOIN pg_am am ON am.oid=o.${o.kind === "OPERATOR CLASS" ? "opcmethod" : "opfmethod"} WHERE o.oid=$1`,
          [o.oid],
        )
      )[0].name;
    }
    delete o.catalog;
    delete o.oid;
    objects.push(o);
  }
  const defaultPrivileges = await rows(
    `SELECT pg_get_userbyid(d.defaclrole) AS owner,coalesce(n.nspname,'') AS schema,d.defaclobjtype AS kind,d.defaclacl::text AS acl FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace`,
  );
  for (const row of defaultPrivileges) row.acl = order(await rows(aclSQL, [row.acl]));
  const extensions = await rows(
    `SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema,pg_get_userbyid(e.extowner) AS owner FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname<>'plpgsql'`,
  );
  const tables = await rows(
    `SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespaces} AND c.relkind IN ('r','m')`,
  );
  for (const table of tables) {
    const hash = createHash("sha256");
    let count = 0n;
    await client.query(
      `DECLARE backup_rows NO SCROLL CURSOR FOR SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') COLLATE "C" AS hash FROM ONLY ${qname(table.schema, table.name)} t ORDER BY 1`,
    );
    while (true) {
      const batch = await rows("FETCH 512 FROM backup_rows");
      if (!batch.length) break;
      for (const row of batch) {
        hash.update(row.hash + "\n");
        count++;
      }
    }
    await client.query("CLOSE backup_rows");
    table.count = String(count);
    table.sha256 = hash.digest("hex");
  }
  const sequences = await captureSequences(client);
  const indexes = await rows(
    `SELECT n.nspname AS schema,c.relname AS name,pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid AS valid,i.indisready AS ready,i.indislive AS live FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespaces}`,
  );
  const constraints = await rows(
    `SELECT n.nspname AS schema,coalesce(c.relname,'') AS table,co.conname AS name,pg_get_constraintdef(co.oid,true) AS definition,co.convalidated AS validated FROM pg_constraint co JOIN pg_namespace n ON n.oid=co.connamespace LEFT JOIN pg_class c ON c.oid=co.conrelid WHERE ${namespaces}`,
  );
  for (const row of [...indexes, ...constraints]) {
    row.definitionSha256 = digest(row.definition);
    delete row.definition;
  }
  ensure(
    (
      await rows(
        `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespaces} AND t.tgisinternal AND t.tgenabled<>'O'`,
      )
    )[0].n === 0,
  );
  const triggers = await rows(
    `SELECT n.nspname AS schema,c.relname AS table,t.tgname AS name,pg_get_triggerdef(t.oid,true) AS definition,t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespaces} AND NOT t.tgisinternal`,
  );
  for (const t of triggers) {
    t.definitionSha256 = digest(t.definition);
    delete t.definition;
  }
  const journal = tables.find((t) => t.schema === "drizzle" && t.name === "__drizzle_migrations");
  const result = {
    roles,
    memberships,
    objects,
    defaultPrivileges,
    extensions,
    tables,
    sequences,
    indexes,
    constraints,
    triggers,
    migrationJournal: journal ? { count: journal.count, sha256: journal.sha256 } : null,
  };
  for (const value of Object.values(result)) if (Array.isArray(value)) order(value);
  return validateInventory(result);
}
export async function captureSequences(client) {
  const sequences = (
    await client.query(
      `SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${namespaces} AND c.relkind='S'`,
    )
  ).rows;
  for (const sequence of sequences) {
    const row = (
      await client.query(
        `SELECT last_value::text AS "lastValue",is_called AS "isCalled" FROM ${qname(sequence.schema, sequence.name)}`,
      )
    ).rows[0];
    Object.assign(sequence, row);
  }
  return order(sequences);
}
export function mapInventory(source, mapping) {
  const value = validateInventory(source);
  keys(mapping, ["version", "roles", "allowedDeltas"]);
  ensure(
    mapping.version === 1 && Array.isArray(mapping.roles) && Array.isArray(mapping.allowedDeltas),
  );
  const names = new Set(value.roles.map((r) => r.name));
  const references = new Set(names);
  for (const object of value.objects) {
    references.add(object.owner);
    for (const a of object.acl) {
      references.add(a.grantee);
      references.add(a.grantor);
    }
  }
  for (const d of value.defaultPrivileges) {
    references.add(d.owner);
    for (const a of d.acl) {
      references.add(a.grantee);
      references.add(a.grantor);
    }
  }
  for (const ext of value.extensions) references.add(ext.owner);
  for (const m of value.memberships)
    for (const k of ["role", "member", "grantor"]) references.add(m[k]);
  references.delete("PUBLIC");
  const map = new Map();
  const destinations = new Set();
  for (const entry of mapping.roles) {
    keys(entry, ["source", "target"]);
    ensure(
      identifier(entry.source) &&
        identifier(entry.target) &&
        !map.has(entry.source) &&
        !destinations.has(entry.target) &&
        references.has(entry.source) &&
        entry.target !== "restore_admin",
    );
    if (entry.source.startsWith("pg_")) ensure(entry.target === entry.source);
    else ensure(!entry.target.startsWith("pg_"));
    map.set(entry.source, entry.target);
    destinations.add(entry.target);
  }
  ensure(map.size === references.size);
  const rename = (name) => {
    if (name === "PUBLIC") return name;
    ensure(map.has(name));
    return map.get(name);
  };
  const required = [];
  for (const r of value.roles) {
    for (const attribute of Object.keys(leastPrivilegeRoleAttributes)) {
      if (r[attribute])
        required.push({ kind: "role-attribute", source: r.name, attribute, from: true, to: false });
      r[attribute] = false;
    }
    r.name = rename(r.name);
  }
  for (const m of value.memberships)
    required.push({ kind: "membership-removal", role: m.role, member: m.member });
  ensure(canonical(order(required)) === canonical(order(structuredClone(mapping.allowedDeltas))));
  value.memberships = [];
  const remapAcl = (acl) =>
    order(acl.map((a) => ({ ...a, grantor: rename(a.grantor), grantee: rename(a.grantee) })));
  for (const o of value.objects) {
    ensure(objectKinds.has(o.kind));
    o.owner = rename(o.owner);
    o.acl = remapAcl(o.acl);
  }
  for (const d of value.defaultPrivileges) {
    d.owner = rename(d.owner);
    d.acl = remapAcl(d.acl);
  }
  for (const ext of value.extensions) ext.owner = rename(ext.owner);
  for (const v of Object.values(value)) if (Array.isArray(v)) order(v);
  return value;
}
export function roleSql(inventory) {
  return inventory.roles
    .map((r) => {
      ensure(
        identifier(r.name) &&
          Object.entries(leastPrivilegeRoleAttributes).every(([key, value]) => r[key] === value) &&
          Number.isSafeInteger(r.connectionLimit),
      );
      return `CREATE ROLE ${quote(r.name)} ${r.login ? "LOGIN" : "NOLOGIN"} ${leastPrivilegeRoleSql} ${r.inherit ? "INHERIT" : "NOINHERIT"} CONNECTION LIMIT ${r.connectionLimit};`;
    })
    .join("\n");
}
function objectIdentity(o) {
  ensure(objectKinds.has(o.kind));
  const name = qname(o.schema, o.name);
  if (o.kind === "OPERATOR") {
    ensure(
      /^[+*<>=~!@#%^&|`?/-]+$/u.test(o.name) && !o.name.includes("--") && !o.name.includes("/*"),
    );
    return `${quote(o.schema)}.${o.name}(${o.args.map((a) => (a.name === null ? "NONE" : qname(a.schema, a.name))).join(",")})`;
  }
  if (["OPERATOR CLASS", "OPERATOR FAMILY"].includes(o.kind))
    return name + " USING " + quote(o.method);
  return ["FUNCTION", "PROCEDURE"].includes(o.kind)
    ? name + "(" + o.args.map((a) => qname(a.schema, a.name)).join(",") + ")"
    : name;
}
const grantKind = (kind) =>
  ["VIEW", "MATERIALIZED VIEW"].includes(kind) ? "TABLE" : kind === "DOMAIN" ? "TYPE" : kind;
function grantStatements(acl, on, owner) {
  // Grant authority is per privilege. The object owner inherently holds every
  // grant option; another grantor must first receive that particular option.
  const pending = order(structuredClone(acl)),
    authority = new Map(),
    result = [];
  for (const privilege of privileges) {
    const edges = pending.filter(
      (a) => a.privilege === privilege && a.grantable && a.grantee !== owner,
    );
    const active = new Set(),
      done = new Set();
    const visit = (role) => {
      if (active.has(role)) throw fail("acl-cycle");
      if (done.has(role)) return;
      active.add(role);
      for (const edge of edges.filter((e) => e.grantor === role)) visit(edge.grantee);
      active.delete(role);
      done.add(role);
    };
    for (const edge of edges) visit(edge.grantor);
    authority.set(privilege, new Set([owner]));
  }
  while (pending.length) {
    const index = pending.findIndex((a) => authority.get(a.privilege)?.has(a.grantor));
    if (index < 0) throw fail("acl-prerequisite");
    const [a] = pending.splice(index, 1);
    ensure(privileges.has(a.privilege) && typeof a.grantable === "boolean");
    result.push(
      `SET ROLE ${quote(a.grantor)}; GRANT ${a.privilege} ${on} TO ${roleName(a.grantee)}${a.grantable ? " WITH GRANT OPTION" : ""}; RESET ROLE;`,
    );
    if (a.grantable) authority.get(a.privilege).add(a.grantee);
  }
  return result;
}
export function ownershipSql(inventory) {
  const sql = ["BEGIN;"];
  const owners = [...inventory.objects].sort(
    (a, b) => Number(a.kind === "SEQUENCE") - Number(b.kind === "SEQUENCE"),
  );
  for (const o of owners) {
    sql.push(`ALTER ${o.kind} ${objectIdentity(o)} OWNER TO ${quote(o.owner)};`);
  }
  // A source superuser could grant on objects without an explicit schema USAGE
  // entry. Its mapped role is unprivileged. Borrow only this execution prerequisite
  // within the reconstruction transaction, then remove it before exact schema ACLs.
  const temporaryUsage = new Map();
  const needUsage = (schema, role) => {
    if (schema) temporaryUsage.set(canonical([schema, role]), { schema, role });
  };
  for (const o of inventory.objects) for (const a of o.acl) needUsage(o.schema, a.grantor);
  for (const d of inventory.defaultPrivileges)
    for (const a of d.acl) needUsage(d.schema, a.grantor);
  for (const { schema, role } of temporaryUsage.values())
    sql.push(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)};`);
  const applyAcl = (o) => {
    const on = `ON ${grantKind(o.kind)} ${objectIdentity(o)}`;
    sql.push(`REVOKE ALL ${on} FROM PUBLIC, ${quote(o.owner)};`);
    sql.push(...grantStatements(o.acl, on, o.owner));
  };
  for (const o of inventory.objects.filter((o) => o.kind !== "SCHEMA")) {
    if (o.kind.startsWith("OPERATOR")) {
      ensure(o.acl.length === 0);
      continue;
    }
    applyAcl(o);
  }
  const kinds = { r: "TABLES", S: "SEQUENCES", f: "FUNCTIONS", T: "TYPES", n: "SCHEMAS" };
  for (const d of inventory.defaultPrivileges) {
    ensure(Object.hasOwn(kinds, d.kind));
    const prefix = `ALTER DEFAULT PRIVILEGES FOR ROLE ${quote(d.owner)}${d.schema ? " IN SCHEMA " + quote(d.schema) : ""}`;
    sql.push(`${prefix} REVOKE ALL ON ${kinds[d.kind]} FROM PUBLIC, ${quote(d.owner)};`);
    for (const a of d.acl) {
      ensure(a.grantor === d.owner && privileges.has(a.privilege));
      sql.push(
        `SET ROLE ${quote(d.owner)}; ${prefix} GRANT ${a.privilege} ON ${kinds[d.kind]} TO ${roleName(a.grantee)}${a.grantable ? " WITH GRANT OPTION" : ""}; RESET ROLE;`,
      );
    }
  }
  for (const { schema, role } of temporaryUsage.values())
    sql.push(`REVOKE USAGE ON SCHEMA ${quote(schema)} FROM ${quote(role)};`);
  for (const o of inventory.objects.filter((o) => o.kind === "SCHEMA")) applyAcl(o);
  sql.push("COMMIT;");
  return sql.join("\n");
}
export function compareInventories(expected, actual) {
  const left = validateInventory(expected),
    right = validateInventory(actual);
  for (const area of Object.keys(left))
    if (canonical(left[area]) !== canonical(right[area])) throw fail(`inventory-${area}`);
  return true;
}
