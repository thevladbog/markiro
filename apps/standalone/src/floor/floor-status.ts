import { z } from "zod";

import type { LocalExecutor } from "../local/executor.js";
import { copiesReady, type Pairing } from "../local/reference-sync.js";

/** Where the station works, as the floor's status bar names it; `null` for what the copies do not say. */
export interface FloorPlace {
  organization: string | null;
  line: string | null;
}

const NOWHERE: FloorPlace = { organization: null, line: null };

const ORG_NAME = "SELECT name FROM ref_org";
const LINE_NAME = "SELECT name FROM ref_lines WHERE id = ?";
const nameRow = z.object({ name: z.string() });

/**
 * The organization and the station's line by name, from this pairing's
 * copies once a sync has begun to fill them (`copiesReady`); nothing from a
 * previous pairing's. The line is named even when the office has archived
 * it since: the station still works on it until the office moves it.
 */
export async function readFloorPlace(
  local: LocalExecutor,
  pairing: Pairing,
  lineId: string | null,
): Promise<FloorPlace> {
  if (!(await copiesReady(local, pairing))) return NOWHERE;
  const orgs = await local.query(ORG_NAME, [], nameRow);
  const [org] = orgs;
  const lines = lineId === null ? [] : await local.query(LINE_NAME, [lineId], nameRow);
  const [line] = lines;
  return {
    organization: orgs.length === 1 && org !== undefined ? org.name : null,
    line: line?.name ?? null,
  };
}
