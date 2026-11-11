package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.network.host.ShiftCreateOptionsDto
import app.markiro.handheld.core.network.host.ShiftCreateProductDto
import app.markiro.handheld.core.network.host.ShiftCreateTemplateDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CreateShiftDraftTest {
    private val product = ShiftCreateProductDto("milk", "Молоко", "04600682000020", 1, 12, 30)
    private val options = ShiftCreateOptionsDto(
        lineId = "mobile", lineName = "Мобильная линия", timeZone = "Europe/Moscow",
        palletsAllowed = true, creationAllowed = true, products = listOf(product),
        templates = listOf(
            ShiftCreateTemplateDto("box", "Короб", "box", null),
            ShiftCreateTemplateDto("pallet", "Паллета", "pallet", null),
            ShiftCreateTemplateDto("sheet", "Лист", "sheet", null),
            ShiftCreateTemplateDto("other", "Другая категория", "box", listOf(2)),
        ),
    )
    private val draft = CreateShiftDraft(productId = "milk", plannedDate = "2026-11-12", productionDate = "2026-11-11",
        boxCapacity = "12", palletCapacity = "30")

    @Test fun validationHasSeparateDatesAndDoesNotSendPackingFields() {
        val request = draft.copy(mode = CreateShiftMode.VALIDATION, palletTemplateId = "pallet")
            .request(options, "request")!!
        assertEquals("validation", request.mode)
        assertEquals("mobile", request.expectedLineId)
        assertEquals("2026-11-12", request.plannedDate)
        assertEquals("2026-11-11", request.productionDate)
        assertEquals("box", request.boxTemplateId)
        assertNull(request.plannedQty)
        assertNull(request.boxCapacity)
        assertNull(request.palletTemplateId)
        assertEquals(false, request.palletsEnabled)
    }

    @Test fun aggregationUsesCompatibleTemplatesAndOnlySendsPalletFieldsInPalletMode() {
        val boxed = draft.copy(mode = CreateShiftMode.BOXES, plan = "360")
        val boxes = boxed.request(options, "request")!!
        assertEquals("box", boxes.boxTemplateId)
        assertEquals(360, boxes.plannedQty)
        assertNull(boxes.palletBoxCapacity)
        val pallets = boxed.copy(mode = CreateShiftMode.PALLETS, sheetId = "sheet").request(options, "request")!!
        assertEquals(true, pallets.palletsEnabled)
        assertEquals("pallet", pallets.palletTemplateId)
        assertEquals(30, pallets.palletBoxCapacity)
        assertEquals("sheet", pallets.palletSheetTemplateId)
        assertNull(boxed.copy(mode = CreateShiftMode.PALLETS).request(options.copy(palletsAllowed = false), "request"))
    }

    @Test fun invalidNumbersAndCivilDatesCannotBeSubmitted() {
        for (value in listOf("0", "-1", "1.5", "10000001")) {
            assertNull(draft.copy(plan = value).request(options, "request"))
        }
        assertNull(draft.copy(plannedDate = "2026-02-29").request(options, "request"))
        assertNull(draft.copy(boxCapacity = "100001").request(options, "request"))
        assertEquals(10000000, draft.copy(plan = "10000000").request(options, "request")?.plannedQty)
    }

    @Test fun aGtinOrMarkingCodeSelectsTheProductWithoutGuessingOnDuplicates() {
        assertEquals(product, findCreateProduct("4600682000020", options.products))
        assertEquals(product, findCreateProduct("]d2010460068200002021Serial", options.products))
        assertEquals(product, findCreateProduct("010460068200002021123", options.products))
        assertNull(findCreateProduct("4600682000020", listOf(product, product.copy(id = "other"))))
        assertNull(findCreateProduct("4600682000021", options.products))
    }
}
