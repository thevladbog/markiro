package app.markiro.handheld.core.network.host

import app.markiro.handheld.core.network.SetItemDto
import kotlinx.serialization.Serializable

@Serializable
data class ShiftCreateOptionsDto(
    val lineId: String,
    val lineName: String,
    val timeZone: String,
    val palletsAllowed: Boolean,
    val creationAllowed: Boolean,
    val products: List<ShiftCreateProductDto>,
    val templates: List<ShiftCreateTemplateDto>,
    val boxDefault: String? = null,
    val palletDefault: String? = null,
    val useLotNumbers: Boolean = false,
)

@Serializable
data class ShiftCreateProductDto(
    val id: String,
    val name: String,
    val gtin14: String,
    val group: Int,
    val boxCapacity: Int,
    val palletBoxCapacity: Int,
    val boxPreference: String? = null,
    val boxCategoryDefault: String? = null,
    val palletPreference: String? = null,
    val palletCategoryDefault: String? = null,
    val setItems: List<SetItemDto> = emptyList(),
)

@Serializable
data class ShiftCreateTemplateDto(
    val id: String,
    val name: String,
    val purpose: String,
    val groups: List<Int>?,
    val supportsLotNumber: Boolean = false,
    val lotNumberSourceId: String? = null,
)

@Serializable
data class HostShiftCreateRequest(
    val requestId: String,
    val expectedLineId: String,
    val productId: String,
    val mode: String,
    val productionDate: String,
    val plannedDate: String,
    val boxTemplateId: String? = null,
    val plannedQty: Int? = null,
    val boxCapacity: Int? = null,
    val palletsEnabled: Boolean = false,
    val palletBoxCapacity: Int? = null,
    val palletTemplateId: String? = null,
    val palletSheetTemplateId: String? = null,
    val lotNumber: String? = null,
)
