/** Separate synthetic worker recipes; target PostgreSQL identity remains untouched. */
export const ICU_POSTGRES_BASE =
  "postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";
export const ICU_NODE_BASE =
  "node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd";
export function parseWorkerMode(args) {
  const count = args.filter((v) => v === "--icu").length;
  if (count > 1) throw new Error("Duplicate ICU worker selection");
  return { mode: count ? "icu" : "libc", args: args.filter((v) => v !== "--icu") };
}
export function workerRecipe(mode) {
  if (mode === "libc")
    return "FROM node:24.18.0-bookworm-slim AS node\nFROM postgres:17-bookworm\nCOPY --from=node /usr/local/bin/node /usr/local/bin/node\nCOPY --chown=999:999 runtime /opt/backup\nENTRYPOINT []\nUSER postgres\n";
  if (mode !== "icu") throw new Error("Unknown worker recipe");
  return `FROM ${ICU_NODE_BASE} AS node
FROM ${ICU_POSTGRES_BASE}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# The target retains UID 70. Only this disposable worker uses the protocol UID 999.
RUN set -eux; \
    test "$(id -u postgres)" = 70; test "$(id -g postgres)" = 70; \
    ! awk -F: '$3 == 999 { found=1 } END { exit !found }' /etc/passwd; \
    ! awk -F: '$3 == 999 { found=1 } END { exit !found }' /etc/group; \
    sed -i 's/^postgres:x:70:70:/postgres:x:999:999:/' /etc/passwd; \
    sed -i 's/^postgres:x:70:/postgres:x:999:/' /etc/group; \
    test "$(id -u postgres)" = 999; test "$(id -g postgres)" = 999; \
    chown -R 999:999 /var/lib/postgresql /var/run/postgresql; \
    test ! -e /usr/lib/postgresql/17/bin; mkdir -p /usr/lib/postgresql/17; \
    test "$(command -v postgres)" = /usr/local/bin/postgres; \
    ln -s /usr/local/bin /usr/lib/postgresql/17/bin
COPY --chown=999:999 runtime /opt/backup
ENTRYPOINT []
USER postgres
RUN test "$(id -u)" = 999 && test "$(id -g)" = 999 \
    && node --version && ! ldd /usr/local/bin/node 2>&1 | grep 'not found' \
    && /usr/lib/postgresql/17/bin/postgres --version \
    && /usr/lib/postgresql/17/bin/initdb --version \
    && /usr/lib/postgresql/17/bin/pg_dump --version \
    && /usr/lib/postgresql/17/bin/pg_restore --version
`;
}
