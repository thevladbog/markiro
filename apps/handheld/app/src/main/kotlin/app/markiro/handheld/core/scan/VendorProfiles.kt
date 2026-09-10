package app.markiro.handheld.core.scan

/**
 * Intent-output settings of the built-in scanner services. The action and extra names come from the
 * vendors' documentation (Datalogic "Intent Wedge", Honeywell "Data Intent", Zebra "DataWedge intent
 * output") and are NOT verified on hardware in this slice. Honeywell and Zebra send to the action the
 * operator configures on the device, so both default to the app's own action name.
 */
data class VendorProfile(
    val id: String,
    val label: String,
    val action: String,
    val dataExtra: String,
    val symbologyExtra: String,
    val setupHint: String,
    val manufacturers: List<String>,
)

object VendorProfiles {
    const val APP_ACTION = "app.markiro.handheld.SCAN"

    val DATALOGIC = VendorProfile(
        id = "datalogic",
        label = "Datalogic · Intent Wedge",
        action = "com.datalogic.decodewedge.decode_action",
        dataExtra = "com.datalogic.decode.intentwedge.barcode_string",
        symbologyExtra = "com.datalogic.decode.intentwedge.barcode_type",
        setupHint = "Настройки → Сканер → Wedge → Intent Wedge: включить, действие как выше, доставка Broadcast.",
        manufacturers = listOf("datalogic"),
    )
    val HONEYWELL = VendorProfile(
        id = "honeywell",
        label = "Honeywell · Data Intent",
        action = APP_ACTION,
        dataExtra = "data",
        symbologyExtra = "codeId",
        setupHint = "Настройки → Honeywell Settings → Scanning → Internal Scanner → Data Processing Settings → Data Intent: включить, Action = $APP_ACTION.",
        manufacturers = listOf("honeywell"),
    )
    val ZEBRA = VendorProfile(
        id = "zebra",
        label = "Zebra · DataWedge",
        action = APP_ACTION,
        dataExtra = "com.symbol.datawedge.data_string",
        symbologyExtra = "com.symbol.datawedge.label_type",
        setupHint = "DataWedge → профиль для app.markiro.handheld → Intent output: включить, Intent action = $APP_ACTION, delivery Broadcast.",
        manufacturers = listOf("zebra"),
    )
    val ALL = listOf(DATALOGIC, HONEYWELL, ZEBRA)

    fun defaultFor(manufacturer: String): VendorProfile {
        val needle = manufacturer.lowercase()
        return ALL.firstOrNull { profile -> profile.manufacturers.any { needle.contains(it) } } ?: ZEBRA
    }

    fun byId(id: String): VendorProfile = ALL.firstOrNull { it.id == id } ?: ZEBRA
}
