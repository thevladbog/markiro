import { asc } from "drizzle-orm";
import { createDb, schema, type Db } from "@markiro/db";

import { loadEnv } from "../env";

interface ClassifierGroup {
  code: number;
  name: string;
}

interface ClassifierMapping {
  chzProductGroupCode: number;
  state: "exact" | "ambiguous" | "unmapped";
  categoryId: string | null;
  schemaVersionId: string | null;
}

export function summarizeNationalCatalogMatrix(
  groups: readonly ClassifierGroup[],
  mappings: readonly ClassifierMapping[],
) {
  const byGroup = new Map<number, ClassifierMapping[]>();
  for (const mapping of mappings) {
    const values = byGroup.get(mapping.chzProductGroupCode) ?? [];
    values.push(mapping);
    byGroup.set(mapping.chzProductGroupCode, values);
  }
  const items = [...groups]
    .sort((left, right) => left.code - right.code)
    .map((group) => {
      const candidates = byGroup.get(group.code) ?? [];
      const categoryIds = [
        ...new Set(candidates.flatMap((candidate) => candidate.categoryId ?? [])),
      ].sort();
      const exactCount = candidates.filter((candidate) => candidate.state === "exact").length;
      const schemaVersionIds = [
        ...new Set(candidates.flatMap((candidate) => candidate.schemaVersionId ?? [])),
      ].sort();
      const state =
        candidates.some((candidate) => candidate.state === "ambiguous") || exactCount > 1
          ? ("ambiguous" as const)
          : exactCount === 1
            ? ("exact" as const)
            : ("unmapped" as const);
      return { code: group.code, name: group.name, state, categoryIds, schemaVersionIds };
    });
  return {
    total: items.length,
    exact: items.filter((item) => item.state === "exact").length,
    ambiguous: items.filter((item) => item.state === "ambiguous").length,
    unmapped: items.filter((item) => item.state === "unmapped").length,
    items,
  };
}

export async function reportNationalCatalogMatrix(db: Db) {
  const [groups, mappings] = await Promise.all([
    db
      .select({ code: schema.chzProductGroups.code, name: schema.chzProductGroups.name })
      .from(schema.chzProductGroups)
      .orderBy(asc(schema.chzProductGroups.code)),
    db
      .select({
        chzProductGroupCode: schema.nationalCatalogCategoryGroupMappings.chzProductGroupCode,
        state: schema.nationalCatalogCategoryGroupMappings.state,
        categoryId: schema.nationalCatalogCategoryGroupMappings.categoryId,
        schemaVersionId: schema.nationalCatalogCategoryGroupMappings.schemaVersionId,
        reviewedAt: schema.nationalCatalogCategoryGroupMappings.reviewedAt,
      })
      .from(schema.nationalCatalogCategoryGroupMappings)
      .orderBy(
        asc(schema.nationalCatalogCategoryGroupMappings.chzProductGroupCode),
        asc(schema.nationalCatalogCategoryGroupMappings.categoryId),
      ),
  ]);
  return summarizeNationalCatalogMatrix(
    groups,
    mappings.map((mapping) => ({
      chzProductGroupCode: mapping.chzProductGroupCode,
      categoryId: mapping.categoryId,
      schemaVersionId: mapping.schemaVersionId,
      state: mapping.state === "exact" && !mapping.reviewedAt ? "ambiguous" : mapping.state,
    })),
  );
}

export async function runReportNationalCatalogMatrixCli(options: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: { write(value: string): unknown };
  stderr?: { write(value: string): unknown };
}): Promise<number> {
  try {
    if (options.argv.length > 0) throw new Error("Unknown report argument");
    const env = loadEnv(options.env);
    const { db, pool } = createDb(env.DATABASE_URL);
    try {
      const report = await reportNationalCatalogMatrix(db);
      (options.stdout ?? process.stdout).write(`${JSON.stringify(report)}\n`);
      return report.ambiguous === 0 && report.unmapped === 0 ? 0 : 2;
    } finally {
      await pool.end();
    }
  } catch {
    (options.stderr ?? process.stderr).write("National Catalog matrix report failed\n");
    return 1;
  }
}

if (require.main === module) {
  void runReportNationalCatalogMatrixCli({ argv: process.argv.slice(2) }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
