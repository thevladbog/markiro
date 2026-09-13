package app.markiro.handheld.core.grants

/** Facts come from the productive owner inside its transaction, never a transport/UI count. */
internal fun grantEventCosts(event: GrantEventType, units: Long?, containers: Long?): Map<String, Long> {
    val costs = linkedMapOf("${event.wire}:events" to 1L)
    if (event in setOf(GrantEventType.SHIFT_SCAN, GrantEventType.SHIFT_LABEL_PREPARE, GrantEventType.INVENTORY_SCAN, GrantEventType.INVENTORY_REPACK, GrantEventType.PICKUP_COMPLETE)) {
        require(units != null && safe(units)); costs["${event.wire}:units"] = units
    }
    if (event in setOf(GrantEventType.SHIFT_BOX_CLOSE, GrantEventType.SHIFT_PALLET_CLOSE, GrantEventType.INVENTORY_BOX_CLOSE, GrantEventType.PICKUP_COMPLETE)) {
        require(containers != null && safe(containers)); costs["${event.wire}:containers"] = containers
    }
    return costs
}
