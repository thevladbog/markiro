package app.markiro.handheld.core.scan

import app.markiro.handheld.R

/**
 * Intent-output settings of the built-in scanner services.
 *
 * Actions and extra names come from the vendors' own documentation (Urovo
 * `ScanManager`, Newland's PDA API handbook, Datalogic "Intent Wedge",
 * Honeywell "Data Intent", Zebra "DataWedge intent output") and from the
 * integrator knowledge bases for the rebranded hardware sold in Russia. Only
 * Honeywell is confirmed on a terminal; everything else is documentation until
 * a device says otherwise, which is why [VendorProfiles.CUSTOM_ID] exists and
 * why the scanner settings screen reports the broadcast it actually received.
 *
 * Honeywell and Zebra send to the action the operator configures on the device,
 * so both default to the app's own action name.
 */
data class VendorProfile(
    val id: String,
    val label: String,
    val action: String,
    /** Tried in order: a service can send the same code under more than one key. */
    val dataExtras: List<String>,
    val symbologyExtras: List<String> = emptyList(),
    /** A broadcast carrying a category matches only a filter that declares it. */
    val category: String? = null,
    /** String resource with the device-side setup steps; `%1$s` is the intent action. */
    val setupHintRes: Int = R.string.vendor_hint_generic,
    val manufacturers: List<String> = emptyList(),
)

object VendorProfiles {
    const val APP_ACTION = "app.markiro.handheld.SCAN"
    const val CUSTOM_ID = "custom"

    val DATALOGIC = VendorProfile(
        id = "datalogic",
        label = "Datalogic · Intent Wedge",
        action = "com.datalogic.decodewedge.decode_action",
        dataExtras = listOf("com.datalogic.decode.intentwedge.barcode_string"),
        symbologyExtras = listOf("com.datalogic.decode.intentwedge.barcode_type"),
        setupHintRes = R.string.vendor_hint_datalogic,
        manufacturers = listOf("datalogic"),
    )
    val HONEYWELL = VendorProfile(
        id = "honeywell",
        label = "Honeywell · Data Intent",
        action = APP_ACTION,
        dataExtras = listOf("data"),
        symbologyExtras = listOf("codeId"),
        setupHintRes = R.string.vendor_hint_honeywell,
        manufacturers = listOf("honeywell"),
    )
    val ZEBRA = VendorProfile(
        id = "zebra",
        label = "Zebra · DataWedge",
        action = APP_ACTION,
        dataExtras = listOf("com.symbol.datawedge.data_string"),
        symbologyExtras = listOf("com.symbol.datawedge.label_type"),
        setupHintRes = R.string.vendor_hint_zebra,
        manufacturers = listOf("zebra"),
    )

    /**
     * `barcode_string` is tried before `barcode` because the byte array is
     * padded to the decoder's buffer and only `length` says where the code ends.
     * The same service ships under several names on this market.
     */
    val UROVO = VendorProfile(
        id = "urovo",
        label = "Urovo · ScanManager",
        action = "android.intent.ACTION_DECODE_DATA",
        dataExtras = listOf("barcode_string", "barcode"),
        symbologyExtras = listOf("barcodeType"),
        setupHintRes = R.string.vendor_hint_urovo,
        manufacturers = listOf("urovo", "meferi", "idata"),
    )
    val XCHENG = VendorProfile(
        id = "xcheng",
        label = "АТОЛ Smart, Mertech · Barcode Utility",
        action = "com.xcheng.scanner.action.BARCODE_DECODING_BROADCAST",
        dataExtras = listOf("EXTRA_BARCODE_DECODING_DATA"),
        setupHintRes = R.string.vendor_hint_xcheng,
        manufacturers = listOf("atol", "mertech"),
    )

    /** The other half of the АТОЛ range: a different scan engine, a different service. */
    val HHT = VendorProfile(
        id = "hht",
        label = "АТОЛ Smart.Pro · ScanWedge",
        action = "com.hht.scanwedge",
        dataExtras = listOf("com.hht.datawedge.data_string"),
        symbologyExtras = listOf("com.hht.datawedge.label_type"),
        category = "android.intent.category.DEFAULT",
        setupHintRes = R.string.vendor_hint_hht,
    )
    val NEWLAND = VendorProfile(
        id = "newland",
        label = "Newland · Scanner Result",
        action = "nlscan.action.SCANNER_RESULT",
        dataExtras = listOf("SCAN_BARCODE1"),
        symbologyExtras = listOf("SCAN_BARCODE_TYPE"),
        setupHintRes = R.string.vendor_hint_newland,
        manufacturers = listOf("newland", "nlscan"),
    )
    val CHAINWAY = VendorProfile(
        id = "chainway",
        label = "Chainway · Scanner Broadcast",
        action = "com.scanner.broadcast",
        dataExtras = listOf("data", "dataBytes"),
        setupHintRes = R.string.vendor_hint_chainway,
        manufacturers = listOf("chainway", "rscja", "seuic"),
    )

    val ALL = listOf(DATALOGIC, HONEYWELL, ZEBRA, UROVO, XCHENG, HHT, NEWLAND, CHAINWAY)

    /**
     * Only decides which setup hint the settings screen leads with. Every
     * profile is listened to regardless, so a wrong guess here costs a scroll,
     * not a scan.
     */
    fun defaultFor(manufacturer: String): VendorProfile {
        val needle = manufacturer.lowercase()
        return ALL.firstOrNull { profile -> profile.manufacturers.any { needle.contains(it) } } ?: UROVO
    }

    fun byId(id: String): VendorProfile = ALL.firstOrNull { it.id == id } ?: UROVO

    /**
     * What an operator types when a terminal speaks something no profile knows.
     * Every one of these services lets the action be renamed in its own
     * settings, so this is the difference between a field visit and a release.
     */
    fun custom(action: String, dataExtra: String, symbologyExtra: String): VendorProfile? {
        if (action.isBlank() || dataExtra.isBlank()) return null
        return VendorProfile(
            id = CUSTOM_ID,
            label = "",
            action = action.trim(),
            dataExtras = listOf(dataExtra.trim()),
            symbologyExtras = listOfNotNull(symbologyExtra.trim().ifEmpty { null }),
        )
    }
}
