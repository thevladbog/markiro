import { canonical, digest, ensure } from "./schemas.mjs";

// Catalog identities are resolved names, never source-cluster OIDs. Live columns
// remain ordered, but physical attnum gaps left by DROP COLUMN are not semantic.
export async function relationDefinition(rows, object) {
  const oid = [object.oid];
  const columns = await rows(
    `SELECT a.attname AS name,tn.nspname AS "typeSchema",t.typname AS "typeName",a.atttypmod AS typmod,a.attnotnull AS "notNull",pg_get_expr(d.adbin,d.adrelid,true) AS expression,a.attgenerated AS generated,a.attidentity AS identity,cn.nspname AS "collationSchema",co.collname AS "collationName"
     FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace tn ON tn.oid=t.typnamespace
     LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
     WHERE a.attrelid=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
    oid,
  );
  const relation = (
    await rows(
      `SELECT c.relkind AS kind,pg_get_partkeydef(c.oid) AS "partitionKey",pg_get_expr(c.relpartbound,c.oid,true) AS "partitionBound",ARRAY(SELECT unnest(coalesce(c.reloptions,ARRAY[]::text[])) ORDER BY 1) AS options FROM pg_class c WHERE c.oid=$1`,
      oid,
    )
  )[0];
  ensure(relation);
  const parents = await rows(
    `SELECT n.nspname AS schema,c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhparent JOIN pg_namespace n ON n.oid=c.relnamespace WHERE i.inhrelid=$1 ORDER BY i.inhseqno`,
    oid,
  );
  const view = ["VIEW", "MATERIALIZED VIEW"].includes(object.kind)
    ? (await rows("SELECT pg_get_viewdef($1::oid,true) AS query", oid))[0]
    : null;
  return digest(canonical({ columns, relation, parents, view }));
}
export async function sequenceDefinition(rows, object) {
  const parameters = (
    await rows(
      `SELECT n.nspname AS "typeSchema",t.typname AS "typeName",s.seqstart::text AS start,s.seqincrement::text AS increment,s.seqmin::text AS min,s.seqmax::text AS max,s.seqcache::text AS cache,s.seqcycle AS cycle FROM pg_sequence s JOIN pg_type t ON t.oid=s.seqtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE s.seqrelid=$1`,
      [object.oid],
    )
  )[0];
  ensure(parameters);
  const ownedBy = await rows(
    `SELECT n.nspname AS schema,c.relname AS table,a.attname AS column,d.deptype AS kind FROM pg_depend d JOIN pg_class c ON c.oid=d.refobjid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.refobjsubid WHERE d.classid='pg_class'::regclass AND d.objid=$1 AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i') ORDER BY n.nspname,c.relname,a.attname`,
    [object.oid],
  );
  return digest(canonical({ parameters, ownedBy }));
}
export async function typeDefinition(rows, object) {
  const type = (
    await rows("SELECT t.typtype AS kind,t.typisdefined AS defined FROM pg_type t WHERE t.oid=$1", [
      object.oid,
    ])
  )[0];
  ensure(type && type.defined === true);
  let definition;
  if (type.kind === "e") {
    definition = await rows(
      "SELECT enumlabel AS label FROM pg_enum WHERE enumtypid=$1 ORDER BY enumsortorder",
      [object.oid],
    );
  } else if (type.kind === "d") {
    definition = (
      await rows(
        `SELECT t.typnotnull AS "notNull",pg_get_expr(t.typdefaultbin,0,true) AS expression,n.nspname AS "typeSchema",b.typname AS "typeName",t.typtypmod AS typmod,cn.nspname AS "collationSchema",co.collname AS "collationName" FROM pg_type t JOIN pg_type b ON b.oid=t.typbasetype JOIN pg_namespace n ON n.oid=b.typnamespace LEFT JOIN pg_collation co ON co.oid=t.typcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace WHERE t.oid=$1`,
        [object.oid],
      )
    )[0];
    ensure(definition);
    // Bind constraints to this domain; the global constraint table alone has
    // no relation name for domain constraints and cannot express that binding.
    definition.constraints = await rows(
      "SELECT conname AS name,pg_get_constraintdef(oid,true) AS definition,convalidated AS validated FROM pg_constraint WHERE contypid=$1 ORDER BY conname",
      [object.oid],
    );
  } else {
    // Only the already-version-pinned trusted extension's base types are allowed.
    ensure(type.kind === "b" && object.extension === "btree_gist");
    definition = (
      await rows(
        `SELECT typlen AS length,typbyval AS "byValue",typcategory AS category,typispreferred AS preferred,typdelim AS delimiter,typalign AS alignment,typstorage AS storage,typinput::regprocedure::text AS input,typoutput::regprocedure::text AS output,typreceive::regprocedure::text AS receive,typsend::regprocedure::text AS send,typmodin::regprocedure::text AS "modIn",typmodout::regprocedure::text AS "modOut",typanalyze::regprocedure::text AS analyze FROM pg_type WHERE oid=$1`,
        [object.oid],
      )
    )[0];
    ensure(definition);
  }
  return digest(canonical({ kind: type.kind, definition }));
}
