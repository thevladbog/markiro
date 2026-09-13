import { json, type RequestHandler } from "express";
/** Main disables Nest's parser for Better Auth; capture bytes only for negotiated routes. */
const parse = json({
  limit: 4 * 1024 * 1024,
  verify(req, _res, bytes) {
    (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(bytes);
  },
});
export const grantEvidenceBodyParser: RequestHandler = (req, res, next) => {
  if (req.method === "POST" && /^\/(?:station|kiosk)\/grants\/v1\/evidence\//i.test(req.path))
    return parse(req, res, next);
  next();
};
