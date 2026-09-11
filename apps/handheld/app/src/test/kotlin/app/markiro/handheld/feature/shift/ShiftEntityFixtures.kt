package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.storage.ShiftEntity

object ShiftEntityFixtures {
    fun listed(id: String, lineId: String? = "l1", mode: String = "validation", status: String = "planned") = ShiftEntity(
        id = id, number = "SEP26-${id.takeLast(1).padStart(3, '0')}", status = status, mode = mode, productId = "p1",
        productName = "Вода 0,5", productPrintName = null, productGtin14 = null, lineId = lineId, lineName = if (lineId == null) null else "Линия 2",
        counterpartyName = null, plannedQty = 100, plannedDate = "2026-09-10", productionDate = null, boxCapacity = null,
        palletBoxCapacity = null, palletsEnabled = false, validationPrintMode = "none", closePolicyKind = null,
        closeOwnerDeviceId = null, openedAt = null, listFetchedAt = 1L,
    )

    fun bundled(id: String) = listed(id, status = "active").copy(productGtin14 = "04600682000013", bundleFetchedAt = 1L, enteredAt = 1L)
}
