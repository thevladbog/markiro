//! Compatible copies of the stock layouts. The source templates and any snapshots that
//! refer to them stay intact.

use serde::Deserialize;
use serde_json::Value;
use sqlx::{Error, SqliteConnection, SqlitePool};

use crate::db::{begin_write, next_revision};

#[derive(Deserialize)]
struct Variants {
    labels: Vec<LabelVariant>,
    sheets: Vec<SheetVariant>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LabelVariant {
    name: String,
    purpose: String,
    source_name: String,
    source_spec: Value,
    updated_source_spec: Option<Value>,
    previous_spec: Option<Value>,
    #[serde(default)]
    add_source: bool,
    spec: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SheetVariant {
    key: String,
    name: String,
    source_key: String,
    source_spec: Value,
    spec: Value,
}

fn variants() -> Result<Variants, Error> {
    serde_json::from_str(include_str!("../stock/lot-number-variants.json"))
        .map_err(|error| Error::Decode(Box::new(error)))
}

#[derive(sqlx::FromRow)]
struct SourceLabel {
    id: String,
    name: String,
    purpose: String,
    spec: String,
    enabled: bool,
    category_codes: Option<String>,
}

pub(crate) async fn add_label_variants(
    conn: &mut SqliteConnection,
    rev: Option<i64>,
) -> Result<(), Error> {
    let sources: Vec<SourceLabel> = sqlx::query_as(
        "SELECT id, name, purpose, spec, enabled, category_codes FROM label_templates source \
         WHERE stock = 1 AND lot_number_source_id IS NULL AND NOT EXISTS ( \
            SELECT 1 FROM label_templates variant WHERE variant.lot_number_source_id = source.id \
         )",
    )
    .fetch_all(&mut *conn)
    .await?;
    if sources.is_empty() {
        return Ok(());
    }
    let variants = variants()?.labels;
    let mut revision = rev;
    for source in sources {
        let spec: Value =
            serde_json::from_str(&source.spec).map_err(|error| Error::Decode(Box::new(error)))?;
        let Some(variant) = variants.iter().find(|variant| {
            variant.source_name == source.name
                && variant.purpose == source.purpose
                && (variant.source_spec == spec
                    || variant.updated_source_spec.as_ref() == Some(&spec))
        }) else {
            continue;
        };
        let rev = match revision {
            Some(rev) => rev,
            None => {
                let rev = next_revision(conn).await?;
                revision = Some(rev);
                rev
            }
        };
        sqlx::query(
            "INSERT INTO label_templates \
             (id, name, purpose, enabled, category_codes, spec, stock, rev, lot_number_source_id) \
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&variant.name)
        .bind(&source.purpose)
        .bind(source.enabled)
        .bind(&source.category_codes)
        .bind(variant.spec.to_string())
        .bind(rev)
        .bind(source.id)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

pub(crate) async fn add_sheet_variants(conn: &mut SqliteConnection, at: &str) -> Result<(), Error> {
    let variants = variants()?.sheets;
    for variant in variants {
        let source: Option<(String, bool, String)> = sqlx::query_as(
            "SELECT id, enabled, spec FROM pallet_sheet_templates WHERE preset_key = ? \
             AND lot_number_variant_seeded = 0 AND NOT EXISTS (SELECT 1 FROM pallet_sheet_templates WHERE preset_key = ?)",
        )
        .bind(&variant.source_key)
        .bind(&variant.key)
        .fetch_optional(&mut *conn)
        .await?;
        let Some((id, enabled, spec)) = source else {
            continue;
        };
        let spec: Value =
            serde_json::from_str(&spec).map_err(|error| Error::Decode(Box::new(error)))?;
        if spec != variant.source_spec {
            continue;
        }
        sqlx::query(
            "INSERT INTO pallet_sheet_templates \
             (id, name, enabled, preset_key, spec, revision, created_at, updated_at, lot_number_source_id) \
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&variant.name)
        .bind(enabled)
        .bind(&variant.key)
        .bind(variant.spec.to_string())
        .bind(at)
        .bind(at)
        .bind(&id)
        .execute(&mut *conn)
        .await?;
        sqlx::query("UPDATE pallet_sheet_templates SET lot_number_variant_seeded = 1 WHERE id = ?")
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// Upgrade only exact stock specs. A planned shift still refers to live templates.
/// Active and closed shifts and previously prepared print jobs have their own snapshots.
async fn update_stock_labels(
    conn: &mut SqliteConnection,
    revision: Option<i64>,
) -> Result<Option<i64>, Error> {
    let initialized: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM org_profile)")
        .fetch_one(&mut *conn)
        .await?;
    if !initialized {
        return Ok(revision);
    }
    let variants = variants()?.labels;
    let existing: Vec<(String, String, String, String, bool, bool)> = sqlx::query_as(
        "SELECT t.id, t.name, t.purpose, t.spec, t.lot_number_source_id IS NOT NULL, \
            t.stock = 1 AND NOT EXISTS(SELECT 1 FROM shifts s WHERE s.status = 'planned' AND \
              (s.box_template_id = t.id OR s.pallet_template_id = t.id OR s.validation_print_template_id = t.id)) \
         FROM label_templates t",
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut updates = Vec::new();
    for (id, name, purpose, spec, is_lot, can_update) in &existing {
        if !can_update {
            continue;
        }
        let current: Value =
            serde_json::from_str(spec).map_err(|error| Error::Decode(Box::new(error)))?;
        for variant in &variants {
            if variant.purpose != *purpose {
                continue;
            }
            if !is_lot && variant.source_name == *name && variant.source_spec == current {
                if let Some(updated) = &variant.updated_source_spec {
                    updates.push((id, updated));
                }
                break;
            }
            if *is_lot && variant.name == *name && variant.previous_spec.as_ref() == Some(&current)
            {
                updates.push((id, &variant.spec));
                break;
            }
        }
    }
    let additions = variants
        .iter()
        .filter(|variant| {
            variant.add_source
                && !existing.iter().any(|(_, name, purpose, _, _, _)| {
                    *name == variant.source_name && *purpose == variant.purpose
                })
        })
        .collect::<Vec<_>>();
    if updates.is_empty() && additions.is_empty() {
        return Ok(revision);
    }
    let rev = match revision {
        Some(rev) => rev,
        None => next_revision(conn).await?,
    };
    for (id, spec) in updates {
        sqlx::query("UPDATE label_templates SET spec = ?, rev = ? WHERE id = ?")
            .bind(spec.to_string())
            .bind(rev)
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    for variant in additions {
        sqlx::query(
            "INSERT INTO label_templates (id, name, purpose, enabled, spec, stock, rev) \
             VALUES (?, ?, ?, 1, ?, 1, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&variant.source_name)
        .bind(&variant.purpose)
        .bind(variant.source_spec.to_string())
        .bind(rev)
        .execute(&mut *conn)
        .await?;
    }
    Ok(Some(rev))
}

pub(crate) async fn register_labels(
    conn: &mut SqliteConnection,
    revision: Option<i64>,
) -> Result<(), Error> {
    let rev = update_stock_labels(conn, revision).await?;
    add_label_variants(conn, rev).await
}

/// Called before the host starts serving, including after a restored database is opened.
pub(crate) async fn register(pool: &SqlitePool, at: &str) -> Result<(), Error> {
    let mut tx = begin_write(pool).await?;
    register_labels(&mut tx, None).await?;
    add_sheet_variants(&mut tx, at).await?;
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn existing_site_receives_wide_duplicates_and_updated_stock_pallet_once() {
        let directory = tempfile::tempdir().unwrap();
        let pool = crate::db::open(&directory.path().join("host.db"))
            .await
            .unwrap();
        let at = "2026-11-12T10:00:00Z";
        sqlx::query(
            "INSERT INTO org_profile (id, name, gln, gs1_prefixes, time_zone, rev) \
             VALUES (1, 'Маркиро', '4600682000013', '[\"4600682\"]', 'UTC', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let fixture = variants().unwrap();
        let pallet = fixture
            .labels
            .iter()
            .find(|variant| variant.source_name == "Палета 75×120")
            .unwrap();
        for (id, stock) in [("pallet", true), ("custom", false)] {
            sqlx::query(
                "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, stock, rev) \
                 VALUES (?, ?, 'pallet', 1, '[1]', ?, ?, 0)",
            )
            .bind(id)
            .bind(&pallet.source_name)
            .bind(pallet.source_spec.to_string())
            .bind(stock)
            .execute(&pool)
            .await
            .unwrap();
        }
        register(&pool, at).await.unwrap();
        let rev: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(rev, 1, "publish base and lot templates in one revision");
        register(&pool, at).await.unwrap();
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM label_templates WHERE purpose = 'product_duplicate' AND json_extract(spec, '$.widthMm') = 75",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 4);
        let specs: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT id, spec, category_codes FROM label_templates WHERE id IN ('custom', 'pallet') ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            specs[0],
            (
                "custom".into(),
                pallet.source_spec.to_string(),
                "[1]".into()
            )
        );
        assert_ne!(specs[1].1, pallet.source_spec.to_string());
        assert_eq!(specs[1].2, "[1]");
        let repeated: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(repeated, rev);
    }

    #[tokio::test]
    async fn compatible_stock_templates_are_linked_without_touching_existing_specs() {
        let directory = tempfile::tempdir().unwrap();
        let pool = crate::db::open(&directory.path().join("host.db"))
            .await
            .unwrap();
        let fixture = variants().unwrap();
        let label = fixture.labels.first().unwrap();
        let sheet = fixture.sheets.first().unwrap();
        let edited_sheet = fixture.sheets.get(1).unwrap();
        let at = "2026-11-11T16:00:00Z";
        for (id, spec) in [
            ("stock-label", label.source_spec.clone()),
            ("other-label", Value::Object(Default::default())),
        ] {
            sqlx::query(
                "INSERT INTO label_templates (id, name, purpose, enabled, category_codes, spec, stock, rev) \
                 VALUES (?, ?, ?, 0, '[1]', ?, 1, 0)",
            )
            .bind(id)
            .bind(&label.source_name)
            .bind(&label.purpose)
            .bind(spec.to_string())
            .execute(&pool)
            .await
            .unwrap();
        }
        for (id, preset, spec) in [
            ("stock-sheet", sheet, sheet.source_spec.clone()),
            (
                "other-sheet",
                edited_sheet,
                Value::Object(Default::default()),
            ),
        ] {
            sqlx::query(
                "INSERT INTO pallet_sheet_templates \
                 (id, name, enabled, preset_key, spec, revision, created_at, updated_at) \
                 VALUES (?, 'Исходный лист', 1, ?, ?, 1, ?, ?)",
            )
            .bind(id)
            .bind(&preset.source_key)
            .bind(spec.to_string())
            .bind(at)
            .bind(at)
            .execute(&pool)
            .await
            .unwrap();
        }
        register(&pool, at).await.unwrap();
        register(&pool, at).await.unwrap();
        let labels: Vec<(String, String, bool, String, i64)> = sqlx::query_as(
            "SELECT lot_number_source_id, spec, enabled, category_codes, rev FROM label_templates \
             WHERE lot_number_source_id IS NOT NULL",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            labels,
            vec![(
                "stock-label".into(),
                label.spec.to_string(),
                false,
                "[1]".into(),
                1
            )]
        );
        let sheets: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT lot_number_source_id, preset_key, spec FROM pallet_sheet_templates \
             WHERE lot_number_source_id IS NOT NULL",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            sheets,
            vec![(
                "stock-sheet".into(),
                sheet.key.clone(),
                sheet.spec.to_string()
            )]
        );
        let unchanged: String =
            sqlx::query_scalar("SELECT spec FROM label_templates WHERE id = 'stock-label'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(unchanged, label.source_spec.to_string());
        let revision: i64 = sqlx::query_scalar("SELECT rev FROM host_revision WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(revision, 1);

        sqlx::query(
            "DELETE FROM pallet_sheet_templates WHERE lot_number_source_id = 'stock-sheet'",
        )
        .execute(&pool)
        .await
        .unwrap();
        register(&pool, at).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pallet_sheet_templates WHERE lot_number_source_id = 'stock-sheet'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}
