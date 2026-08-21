import { BadRequestException } from "@nestjs/common";
import { and, asc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@markiro/db";
import {
  stationCodeReleaseRevisionSchema,
  type StationCodeReleasesDto,
  type StationCodeReleasesResponseDto,
} from "./dto";

export const CODE_RELEASE_PAGE_SIZE = 200;

const codeReleaseCursorSchema = z
  .object({
    v: z.literal(1),
    since: stationCodeReleaseRevisionSchema,
    until: stationCodeReleaseRevisionSchema,
    registryVersion: stationCodeReleaseRevisionSchema,
    boxId: z.string().uuid(),
    codeHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

type CodeReleaseCursor = z.infer<typeof codeReleaseCursorSchema>;
type CodeReleaseExecutor = Pick<Db, "select">;

function badCursor(): BadRequestException {
  return new BadRequestException("Invalid station code release cursor");
}

function encodeCursor(cursor: CodeReleaseCursor): string {
  return Buffer.from(JSON.stringify(codeReleaseCursorSchema.parse(cursor)), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(raw: string): CodeReleaseCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw badCursor();
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw badCursor();
    const parsed = codeReleaseCursorSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
    if (encodeCursor(parsed) !== raw) throw badCursor();
    return parsed;
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw badCursor();
  }
}

async function currentVersion(db: CodeReleaseExecutor, tenantId: string): Promise<string> {
  const [row] = await db
    .select({ currentVersion: schema.boxRegistryVersions.currentVersion })
    .from(schema.boxRegistryVersions)
    .where(eq(schema.boxRegistryVersions.tenantId, tenantId));
  return (row?.currentVersion ?? 0n).toString();
}

/**
 * Incremental invalidation feed for the station's tenant-wide duplicate mirror.
 * `boxes.registryVersion` advances in the same transaction that removes a
 * membership, so stations do not upload their complete code history on every
 * heartbeat.
 */
export async function loadCodeReleasePage(
  db: CodeReleaseExecutor,
  tenantId: string,
  request: StationCodeReleasesDto,
): Promise<StationCodeReleasesResponseDto> {
  const committedVersion = await currentVersion(db, tenantId);
  const since = BigInt(request.since);
  const untilText = request.until ?? committedVersion;
  const until = BigInt(untilText);
  if (since > until || until > BigInt(committedVersion)) {
    throw new BadRequestException("Invalid station code release revision window");
  }

  let cursor: CodeReleaseCursor | null = null;
  if (request.cursor !== undefined) {
    cursor = decodeCursor(request.cursor);
    if (
      cursor.since !== request.since ||
      cursor.until !== untilText ||
      BigInt(cursor.registryVersion) <= since ||
      BigInt(cursor.registryVersion) > until
    ) {
      throw badCursor();
    }
  }

  const afterCursor = cursor
    ? or(
        gt(schema.boxes.registryVersion, BigInt(cursor.registryVersion)),
        and(
          eq(schema.boxes.registryVersion, BigInt(cursor.registryVersion)),
          gt(schema.boxes.id, cursor.boxId),
        ),
        and(
          eq(schema.boxes.registryVersion, BigInt(cursor.registryVersion)),
          eq(schema.boxes.id, cursor.boxId),
          gt(schema.boxItems.codeHash, cursor.codeHash),
        ),
      )
    : undefined;

  const rows = await db
    .select({
      registryVersion: schema.boxes.registryVersion,
      boxId: schema.boxes.id,
      codeHash: schema.boxItems.codeHash,
    })
    .from(schema.boxItems)
    .innerJoin(
      schema.boxes,
      and(
        eq(schema.boxes.tenantId, schema.boxItems.tenantId),
        eq(schema.boxes.id, schema.boxItems.boxId),
      ),
    )
    .leftJoin(
      schema.codeRegistry,
      and(
        eq(schema.codeRegistry.tenantId, schema.boxItems.tenantId),
        eq(schema.codeRegistry.codeHash, schema.boxItems.codeHash),
      ),
    )
    .where(
      and(
        eq(schema.boxItems.tenantId, tenantId),
        gt(schema.boxes.registryVersion, since),
        lte(schema.boxes.registryVersion, until),
        isNotNull(schema.boxItems.removedAt),
        isNull(schema.codeRegistry.codeHash),
        afterCursor,
      ),
    )
    .orderBy(asc(schema.boxes.registryVersion), asc(schema.boxes.id), asc(schema.boxItems.codeHash))
    .limit(CODE_RELEASE_PAGE_SIZE + 1);

  const page = rows.slice(0, CODE_RELEASE_PAGE_SIZE);
  const last = page.at(-1);
  const nextCursor =
    rows.length > CODE_RELEASE_PAGE_SIZE && last
      ? encodeCursor({
          v: 1,
          since: request.since,
          until: untilText,
          registryVersion: last.registryVersion.toString(),
          boxId: last.boxId,
          codeHash: last.codeHash,
        })
      : undefined;
  return {
    until: untilText,
    releasedCodeHashes: page.map((row) => row.codeHash),
    ...(nextCursor ? { nextCursor } : {}),
  };
}
