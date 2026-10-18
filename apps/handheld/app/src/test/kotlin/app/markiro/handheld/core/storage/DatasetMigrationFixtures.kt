package app.markiro.handheld.core.storage

import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import androidx.sqlite.db.SupportSQLiteDatabase

/**
 * Tests that rewind a CURRENT Room file must remove v22 columns as well as
 * lowering user_version. Keep all earlier columns and rows; migration 21->22
 * remains additive and must fail if accidentally applied twice.
 */
fun removeDatasetColumnsForHistoricalFixture(db: SupportSQLiteDatabase) =
    removeDatasetColumnsForHistoricalFixture({ db.query(it) }, { db.execSQL(it) })

fun removeDatasetColumnsForHistoricalFixture(db: SQLiteDatabase) =
    removeDatasetColumnsForHistoricalFixture({ db.rawQuery(it, null) }, { db.execSQL(it) })

private fun removeDatasetColumnsForHistoricalFixture(query: (String) -> Cursor, execute: (String) -> Unit) {
    for ((table, column) in listOf("device_config" to "hostDatasetEpoch", "device_recovery" to "datasetResetEpoch")) {
        val columns = query("PRAGMA table_info(`$table`)").use { rows ->
            buildList { while (rows.moveToNext()) add(rows.getString(1)) }
        }
        if (column !in columns) continue
        val original = query("SELECT sql FROM sqlite_master WHERE type='table' AND name='$table'").use { rows ->
            check(rows.moveToFirst()); rows.getString(0)
        }
        val earlier = original.replace(Regex(",\\s*`?$column`?\\s+TEXT(?=\\s*[,\\)])"), "")
        check(earlier != original)
        val names = columns.filter { it != column }.joinToString(",") { "`$it`" }
        execute("CREATE TEMP TABLE dataset_fixture_copy AS SELECT $names FROM `$table`")
        execute("DROP TABLE `$table`")
        execute(earlier)
        execute("INSERT INTO `$table` ($names) SELECT $names FROM dataset_fixture_copy")
        execute("DROP TABLE dataset_fixture_copy")
    }
}
