/** Old records represent full releases. API-only records retain the exact edge identity. */
export function validReleaseScope(record) {
  const keys = ["scope", "edgeReleaseSha", "edgeContainerId"];
  if (keys.every((key) => record[key] === undefined)) return true;
  return (
    record.scope === "api-only" &&
    typeof record.edgeReleaseSha === "string" &&
    /^[0-9a-f]{40}$/.test(record.edgeReleaseSha) &&
    typeof record.edgeContainerId === "string" &&
    /^[0-9a-f]{64}$/.test(record.edgeContainerId)
  );
}

export function releaseRecordKeys(record) {
  return [
    "apiDigest",
    "createdAt",
    "edgeDigest",
    "previousTag",
    "state",
    "tag",
    ...(record.vbtech === undefined ? [] : ["vbtech"]),
    ...(record.scope === "api-only" ? ["scope", "edgeReleaseSha", "edgeContainerId"] : []),
  ]
    .sort()
    .join(",");
}
