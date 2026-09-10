package app.markiro.handheld.core.storage

object InventoryFixtures {
    fun task(id: String, state: String = "active", snapshotId: String = "snap", mode: String = "check") = InventoryTaskEntity(
        inventoryId = id, inventoryNumber = "INV-0007", productId = "p1", productName = "Вода 0,5 л", productPrintName = "Вода",
        gtin14 = "04600000000015", mode = mode, lineId = "l1", lineName = "Линия 2", productionDateFrom = "2026-08-01",
        productionDateTo = "2026-08-31", boxCapacity = 12, snapshotId = snapshotId, snapshotFixedAt = "2026-08-25T01:02:03.000Z",
        contentDigest = "b".repeat(64), combinedDigest = "a".repeat(64), codeCount = 0, expectedCount = 0, state = state,
        stagingCursor = null, stagedCount = 0, joinedAt = if (state == "active") 1L else null, leftAt = null,
    )

    fun code(
        snapshotId: String,
        hash: String,
        serial: String = hash,
        parentSscc: String? = null,
        expected: Boolean = true,
        protected: Boolean = false,
        status: String = "INTRODUCED",
        state: String? = null,
        date: String? = "2026-08-20",
    ) = InventorySnapshotCodeEntity(
        snapshotId = snapshotId, codeHash = hash, canonicalRaw = "010460000000001521$serial", gtin14 = "04600000000015",
        serial = serial, sourceStatus = status, sourceState = state, sourceProductionDate = date, parentSscc = parentSscc,
        expected = expected, protected = protected,
    )

    fun result(inventoryId: String, snapshotId: String, hash: String, eventId: String, deviceId: String, classification: String = "expected") =
        InventoryResultEntity(
            inventoryId = inventoryId, snapshotId = snapshotId, codeHash = hash, firstAcceptedEventId = eventId, winningDeviceId = deviceId,
            winningScannedAt = "2026-08-25T10:00:00.000Z", observedProductionDate = "2026-08-20", classification = classification,
            source = "local", updatedAt = "2026-08-25T10:00:00.000Z",
        )
}
