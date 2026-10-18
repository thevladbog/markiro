package app.markiro.handheld.core.host

import app.markiro.handheld.core.network.BundleLabelTemplateDto
import app.markiro.handheld.core.network.BundleProductDto
import app.markiro.handheld.core.network.BundleSsccDto
import app.markiro.handheld.core.network.ShiftDto
import app.markiro.handheld.core.network.ValidationPrintDto
import app.markiro.handheld.core.network.host.DeviceShiftDto
import app.markiro.handheld.core.storage.SsccRangeEntity
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull
private fun JsonObject.number(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

/** A shift of the host as `GET /shifts` of the cloud delivered it. The host never prints a duplicate for a handheld (`station_update` otherwise), so the print policy is `none`. */
fun DeviceShiftDto.toShiftDto(lineName: String?) = ShiftDto(
    id = id,
    number = number,
    status = status,
    mode = mode,
    validationPrint = ValidationPrintDto("none"),
    productId = productId,
    productName = productName,
    productPrintName = snapshot?.product?.text("printName"),
    lineId = lineId,
    lineName = lineName,
    counterpartyName = counterpartyName,
    plannedQty = plannedQty,
    plannedDate = plannedDate ?: productionDate,
    productionDate = productionDate,
    boxCapacity = boxCapacity,
    palletBoxCapacity = if (palletsEnabled) palletBoxCapacity else null,
    palletsEnabled = palletsEnabled,
    openedAt = openedAt,
    closedAt = closedAt,
)

fun JsonObject.toBundleProduct() = BundleProductDto(
    id = checkNotNull(text("id")),
    gtin14 = checkNotNull(text("gtin14")),
    name = checkNotNull(text("name")),
    printName = text("printName"),
    shelfLifeDays = number("shelfLifeDays"),
    egaisCode = text("egaisCode"),
)

fun JsonObject.toBundleTemplate() = BundleLabelTemplateDto(
    id = checkNotNull(text("id")),
    name = checkNotNull(text("name")),
    spec = getValue("spec").jsonObject,
)

fun SsccRangeEntity.toBundle() = BundleSsccDto(
    issuerPrefix = issuerPrefix,
    extensionDigit = extensionDigit,
    fromSerial = fromSerial,
    toSerial = toSerial,
    consumedThroughSerial = (nextSerial - 1).takeIf { it >= fromSerial },
    blockId = blockId,
)
