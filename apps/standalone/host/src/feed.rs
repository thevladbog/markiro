//! Station-feed bookkeeping for writers (spec §4.4). A record that leaves the
//! feed — deleted, or no longer granting access, like a deactivated operator
//! or a revoked badge — leaves with a tombstone, never with a flag: a station
//! build that reads records leniently would drop a flag it does not know and
//! keep the access. A key that comes back, like a reactivated operator, drops
//! its tombstone, so the feed never carries both.

use sqlx::SqliteConnection;

/// `entity`/`id` left the station feed at `rev`: write its tombstone, or move
/// an older one up to `rev`.
pub async fn remove(
    conn: &mut SqliteConnection,
    entity: &str,
    id: &str,
    rev: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO tombstones (entity, id, rev) VALUES (?, ?, ?) \
         ON CONFLICT (entity, id) DO UPDATE SET rev = excluded.rev",
    )
    .bind(entity)
    .bind(id)
    .bind(rev)
    .execute(conn)
    .await?;
    Ok(())
}

/// `entity`/`id` is back in the station feed: drop its tombstone. A device
/// that applied the tombstone gets the record again through its newer `rev`.
pub async fn restore(
    conn: &mut SqliteConnection,
    entity: &str,
    id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM tombstones WHERE entity = ? AND id = ?")
        .bind(entity)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}
