package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.inventory.ScanClassifier
import app.markiro.handheld.core.inventory.ScanInput
import app.markiro.handheld.core.network.host.HostShiftCreateRequest
import app.markiro.handheld.core.network.host.ShiftCreateOptionsDto
import app.markiro.handheld.core.network.host.ShiftCreateProductDto
import app.markiro.handheld.core.network.host.ShiftCreateTemplateDto
import kotlinx.serialization.Serializable
import java.time.LocalDate

enum class CreateShiftMode { VALIDATION, BOXES, PALLETS }

internal const val MAX_SHIFT_PLAN = 10_000_000
internal const val MAX_SHIFT_BOX_CAPACITY = 100_000
internal const val MAX_SHIFT_PALLET_CAPACITY = 10_000

@Serializable
data class CreateShiftDraft(
    val productId: String? = null,
    val mode: CreateShiftMode = CreateShiftMode.BOXES,
    val plannedDate: String = "",
    val productionDate: String = "",
    val plan: String = "",
    val boxCapacity: String = "",
    val palletCapacity: String = "",
    val boxTemplateId: String? = null,
    val palletTemplateId: String? = null,
    val sheetId: String? = null,
    val lotNumber: String = "",
) {
    fun withProduct(product: ShiftCreateProductDto): CreateShiftDraft = copy(
        productId = product.id, boxCapacity = product.boxCapacity.toString(), palletCapacity = product.palletBoxCapacity.toString(),
        boxTemplateId = null, palletTemplateId = null, sheetId = null,
    )

    fun product(options: ShiftCreateOptionsDto) = options.products.firstOrNull { it.id == productId }

    fun templates(options: ShiftCreateOptionsDto, purpose: String): List<ShiftCreateTemplateDto> {
        val product = product(options) ?: return emptyList()
        val requiresLot = options.useLotNumbers && normalizedLotNumber().isNotEmpty() && mode != CreateShiftMode.VALIDATION
        return options.templates.filter {
            it.purpose == purpose && (it.groups == null || product.group in it.groups) &&
                (!requiresLot || it.supportsLotNumber)
        }
    }

    fun template(options: ShiftCreateOptionsDto, purpose: String): ShiftCreateTemplateDto? {
        val product = product(options) ?: return null
        val candidates = templates(options, purpose)
        val preferences = when (purpose) {
            "box" -> listOf(boxTemplateId, product.boxPreference, product.boxCategoryDefault, options.boxDefault)
            "pallet" -> listOf(palletTemplateId, product.palletPreference, product.palletCategoryDefault, options.palletDefault)
            else -> listOf(sheetId)
        }
        val selected = preferences.filterNotNull().firstNotNullOfOrNull { id ->
            candidates.firstOrNull { it.id == id } ?: candidates.firstOrNull { it.lotNumberSourceId == id }
        }
        return selected ?: candidates.firstOrNull().takeUnless { purpose == "sheet" }
    }

    fun request(options: ShiftCreateOptionsDto, requestId: String): HostShiftCreateRequest? {
        val product = product(options) ?: return null
        val assembly = product.setItems.isNotEmpty()
        val boxes = !assembly && mode != CreateShiftMode.VALIDATION
        val pallets = !assembly && mode == CreateShiftMode.PALLETS
        if (!options.creationAllowed || (pallets && !options.palletsAllowed)) return null
        val boxTemplate = if (assembly) null else template(options, "box") ?: return null
        val boxCapacity = if (boxes) count(boxCapacity, MAX_SHIFT_BOX_CAPACITY) ?: return null else null
        val palletTemplate = if (pallets) template(options, "pallet") ?: return null else null
        val palletCapacity = if (pallets) count(palletCapacity, MAX_SHIFT_PALLET_CAPACITY) ?: return null else null
        val plan = if (plan.isBlank()) null else count(plan, MAX_SHIFT_PLAN) ?: return null
        if (!civilDate(plannedDate) || !civilDate(productionDate)) return null
        val lot = normalizedLotNumber().takeIf { !assembly && options.useLotNumbers && it.isNotEmpty() }
        if (lot != null && !isLotNumberValid()) return null
        return HostShiftCreateRequest(
            requestId = requestId, expectedLineId = options.lineId, productId = product.id,
            mode = if (boxes) "aggregation" else "validation", productionDate = productionDate,
            plannedDate = plannedDate, boxTemplateId = boxTemplate?.id, plannedQty = plan,
            boxCapacity = boxCapacity, palletsEnabled = pallets, palletBoxCapacity = palletCapacity,
            palletTemplateId = palletTemplate?.id, palletSheetTemplateId = if (pallets) template(options, "sheet")?.id else null,
            lotNumber = lot,
        )
    }

    internal fun isLotNumberValid(): Boolean = LOT_NUMBER.matches(normalizedLotNumber())

    private fun normalizedLotNumber(): String = lotNumber.trim { char ->
        // Match the host and webview when a number is pasted with edge whitespace.
        char in "\t\n\u000b\u000c\r \u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff" ||
            char in '\u2000'..'\u200a'
    }
}

private val LOT_NUMBER = Regex("[0-9A-Za-zА-Яа-яЁё]*")

internal fun count(raw: String, max: Int): Int? =
    raw.takeIf { it.all { char -> char in '0'..'9' } }?.toIntOrNull()?.takeIf { it in 1..max }

private fun civilDate(value: String): Boolean =
    value.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")) &&
        runCatching { LocalDate.parse(value).year in 1..9999 }.getOrDefault(false)

internal fun findCreateProduct(raw: String, products: List<ShiftCreateProductDto>): ShiftCreateProductDto? {
    val gtin = when (val scan = ScanClassifier.classify(raw)) {
        is ScanInput.Gtin -> scan.gtin14
        is ScanInput.Km -> scan.km.gtin14
        is ScanInput.Sscc, is ScanInput.Unknown -> return null
    }
    return products.singleOrNull { it.gtin14 == gtin }
}
