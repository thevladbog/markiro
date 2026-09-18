package app.markiro.handheld.core.network

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/*
 * Wire shapes for warehouse pallets (room 18). Field names mirror
 * `apps/api/src/modules/station-pallets` and the shift bundle's own pallet
 * fields (see `ShiftDtos.kt`); `PalletDtosTest` pins them.
 */

@Serializable
data class PalletBootstrapProductDto(
    val id: String,
    val gtin14: String,
    val name: String,
    val printName: String? = null,
    val shelfLifeDays: Int? = null,
    val palletBoxCapacity: Int? = null,
    val chzProductGroupCode: Int? = null,
)

@Serializable
data class PalletBootstrapOperatorDto(val employeeId: String, val canBuildPallets: Boolean)

@Serializable
data class PalletCategoryTemplateDto(val chzProductGroupCode: Int, val template: JsonElement)

@Serializable
data class PalletLabelTemplatesDto(
    val organisation: JsonElement? = null,
    val byCategory: List<PalletCategoryTemplateDto> = emptyList(),
)

/** `GET /station/pallet-bootstrap` -- products, per-operator permission, this device's extension-1 block and pallet label templates, no shift needed. */
@Serializable
data class PalletBootstrapDto(
    val generatedAt: String,
    val products: List<PalletBootstrapProductDto>,
    val operators: List<PalletBootstrapOperatorDto>,
    val palletSscc: BundleSsccDto? = null,
    val palletSsccRevokedFrom: List<Long> = emptyList(),
    val palletLabelTemplates: PalletLabelTemplatesDto,
)

/** One box joining a warehouse pallet, sent alongside the pallet's own closure. */
@Serializable
data class PalletMembershipDto(
    val palletId: String,
    val boxSscc: String,
    val addedAt: String,
    val operatorId: String?,
)

/** A box taken back off the device's own open warehouse pallet; the undo of [PalletMembershipDto]. */
@Serializable
data class PalletMembershipRemovalDto(
    val palletId: String,
    val boxSscc: String,
    val removedAt: String,
    val operatorId: String?,
)
