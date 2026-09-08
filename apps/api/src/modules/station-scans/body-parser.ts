import { json, type RequestHandler } from "express";

// Scans plus independent closures/exceptions/label events can exceed Express's default 100 KiB.
// Keep the raised bound limited to this endpoint; DTOs still bound every channel and string.
const parse = json({ limit: 2 * 1024 * 1024 });
export const stationScansBodyParser: RequestHandler = (req, res, next) => {
  if (req.method === "POST" && /^\/station\/scans\/?$/i.test(req.path))
    return parse(req, res, next);
  next();
};
