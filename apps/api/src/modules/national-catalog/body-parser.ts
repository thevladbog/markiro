import { json, type RequestHandler } from "express";

// 1,500,000 UTF-16 characters may each use six JSON bytes (\\uXXXX).
// All new import mutations share this finite transport bound; unrelated routes retain 100 KiB.
export const NATIONAL_CATALOG_JSON_LIMIT = 1_500_000 * 6 + 1024;
const parse = json({ limit: NATIONAL_CATALOG_JSON_LIMIT });
export const nationalCatalogBodyParser: RequestHandler = (req, res, next) => {
  if (
    ["POST", "PUT", "PATCH"].includes(req.method) &&
    /^\/national-catalog\/import-sessions(?:\/|$)/i.test(req.path)
  )
    return parse(req, res, next);
  next();
};
