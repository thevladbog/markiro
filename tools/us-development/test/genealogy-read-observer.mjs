/** Only the current/upstream bounded read used by the lot panel is non-mutating. */
export function isBoundedGenealogyRead(request, base) {
  if (request.url() !== `${base}/transformation/genealogy/query` || request.method() !== "POST")
    return false;
  let body;
  try {
    body = request.postDataJSON();
  } catch {
    return false;
  }
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).sort().join(",") === "direction,maxDepth,maxNodes,mode,startLotId" &&
    typeof body.startLotId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.startLotId) &&
    body.mode === "current" &&
    body.direction === "upstream" &&
    body.maxDepth === 4 &&
    body.maxNodes === 100
  );
}
