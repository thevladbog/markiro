package app.markiro.handheld.core.storage

/** Business rows only. New tables must be classified before a reset can clear anything. */
internal val HOST_DATASET_BUSINESS_TABLES = setOf(
    "box_exceptions",
    "box_registry",
    "boxes",
    "codes_mirror",
    "conflicts_mirror",
    "grant_counters",
    "grant_evidence",
    "grant_readiness_outbox",
    "grant_state",
    "grant_task_bindings",
    "grant_task_provenance",
    "grant_tokens",
    "host_outbox",
    "inventory_events",
    "inventory_outbox",
    "inventory_results",
    "inventory_snapshot_codes",
    "inventory_tasks",
    "inventory_terminal_state",
    "meta",
    "operator_badges",
    "operators",
    "outbox",
    "pallet_exceptions",
    "pallet_label_templates",
    "pallet_membership_removals",
    "pallet_memberships",
    "pallet_permissions",
    "pallet_products",
    "pallets",
    "print_destinations",
    "product_label_events",
    "product_label_jobs",
    "replacement_drain",
    "scan_events",
    "shift_close_outbox",
    "shift_mirror",
    "sscc_pool",
    "validation_history",
    "validation_history_publications",
    "validation_occurrences",
    "writeoff_outbox",
    "writeoff_permissions",
    "writeoff_products",
    "writeoff_reasons",
)
private val HOST_DATASET_RETAINED_TABLES = setOf("device_config", "device_recovery", "printers", "printer_assignments")

internal fun clearHostDatasetBusinessTables(db: HandheldDatabase) {
    val sqlite = db.openHelper.writableDatabase
    val tables = sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('room_master_table', 'android_metadata')").use { rows ->
        buildSet { while (rows.moveToNext()) add(rows.getString(0)) }
    }
    check(tables == HOST_DATASET_BUSINESS_TABLES + HOST_DATASET_RETAINED_TABLES) { "Unclassified handheld dataset table" }
    for (table in HOST_DATASET_BUSINESS_TABLES) sqlite.execSQL("DELETE FROM `$table`")
}
