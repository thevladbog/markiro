import { json, type RequestHandler } from "express";
const parse = json({ limit: 1024 * 1024 });
/** Frozen branding is bounded to one source; all other routes retain their parser. */
export const palletSourcesBodyParser: RequestHandler = (req, res, next) => {
  if (
    req.method === "POST" &&
    /^\/station\/warehouse-reprint\/(?:pallet-sources|pallet-renderings-v2|pallet-renderings-v3|pallet-data-v3|label-facts)\/?$/i.test(
      req.path,
    )
  )
    return parse(req, res, next);
  next();
};
