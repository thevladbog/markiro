package app.markiro.handheld.core.inventory

import app.markiro.handheld.core.network.InventoryBundleCodeDto
import org.junit.Assert.assertEquals
import org.junit.Test

class InventoryDigestsTest {
    // Values from packages/domain/test/station-inventory-bundle.test.ts, digests computed with the built domain package.
    private val item = InventoryBundleCodeDto(
        codeHash = "066e15060b18b753ddffa6a92d9d2ce2366b5fc3c704d6d61c89bb77740b47ff", canonicalRaw = "010460000000001521SERIAL-B",
        gtin14 = "04600000000015", serial = "SERIAL-B", sourceStatus = "INTRODUCED", sourceState = null, sourceProductionDate = "2026-08-01",
        parentSscc = null, expected = true, protected = false,
    )

    @Test
    fun escapesLikeJsonStringify() {
        assertEquals("\"a\\\"b\\\\c\\u001dd\\n\\u0000\\fé\"", CanonicalJson.str("a\"b\\c\u001dd\n\u0000\u000cé"))
        assertEquals(
            """{"a":1,"b":null,"c":[true,"x"]}""",
            CanonicalJson.obj("a" to CanonicalJson.num(1), "b" to CanonicalJson.NULL, "c" to CanonicalJson.arr(listOf(CanonicalJson.bool(true), CanonicalJson.str("x")))),
        )
    }

    @Test
    fun contentDigestsMatchTheDomain() {
        assertEquals("024e43bf323bd590229148f46e831f64eb114aac28f44e8f6c9ca7c0932a408f", ContentDigest().finish())
        assertEquals("4e966ef1bc339ad9768627e7b38af49b3667610d44298a4be4751b16edabc573", ContentDigest().also { it.add(InventoryDigests.itemJson(item)) }.finish())
    }

    @Test
    fun pageDigestMatchesTheDomain() {
        assertEquals(
            "8278599d61f87a37036b1ebc836aeb44c31c80d63caf6e6ba6266964eb8b0f1f",
            InventoryDigests.pageDigest("s", "2026-08-25T01:02:03.000Z", "c", null, listOf(item), null),
        )
    }
}
