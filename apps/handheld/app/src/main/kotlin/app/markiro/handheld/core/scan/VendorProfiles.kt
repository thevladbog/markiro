package app.markiro.handheld.core.scan

import app.markiro.handheld.R

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
    /** String resource with the device-side setup steps; `%1$s` is the intent action. */
    val setupHintRes: Int,
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
        setupHintRes = R.string.vendor_hint_datalogic,
        manufacturers = listOf("datalogic"),
    )
    val HONEYWELL = VendorProfile(
        id = "honeywell",
        label = "Honeywell · Data Intent",
        action = APP_ACTION,
        dataExtra = "data",
        symbologyExtra = "codeId",
        setupHintRes = R.string.vendor_hint_honeywell,
        manufacturers = listOf("honeywell"),
    )
    val ZEBRA = VendorProfile(
        id = "zebra",
        label = "Zebra · DataWedge",
        action = APP_ACTION,
        dataExtra = "com.symbol.datawedge.data_string",
        symbologyExtra = "com.symbol.datawedge.label_type",
        setupHintRes = R.string.vendor_hint_zebra,
        manufacturers = listOf("zebra"),
    )
    val ALL = listOf(DATALOGIC, HONEYWELL, ZEBRA)

    fun defaultFor(manufacturer: String): VendorProfile {
        val needle = manufacturer.lowercase()
        return ALL.firstOrNull { profile -> profile.manufacturers.any { needle.contains(it) } } ?: ZEBRA
    }

    fun byId(id: String): VendorProfile = ALL.firstOrNull { it.id == id } ?: ZEBRA
}
