package app.markiro.handheld.core.host

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.backend.HostBackend
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.host.HostPalletFixtures.ok
import app.markiro.handheld.core.host.HostPalletFixtures.routes
import app.markiro.handheld.core.network.host.HostApi
import app.markiro.handheld.core.pallets.SsccBlockApplier
import app.markiro.handheld.core.storage.HandheldDatabase
import app.markiro.handheld.core.storage.MetaStore
import app.markiro.handheld.core.storage.PalletLabelTemplateEntity
import app.markiro.handheld.core.storage.PalletPermissionEntity
import app.markiro.handheld.core.storage.PalletProductEntity
import app.markiro.handheld.core.storage.initializeRecoveryForTest
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostBackendPalletsTest {
    private lateinit var db: HandheldDatabase

    @Before
    fun open() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries().build()
        runBlocking { db.deviceConfigDao().upsert(HostFactsFixtures.config(db)) }
        db.initializeRecoveryForTest()
    }

    @After
    fun close() = db.close()

    @Test
    fun theBootstrapIsWhatTheFeedWroteToRoomPlusTheOrgPrintAndTheExtensionOneBlock() = runTest {
        db.palletProductDao().upsert(PalletProductEntity("p1", "04600682000013", "Вода", null, 365, 40, 3))
        db.palletPermissionDao().upsert(PalletPermissionEntity("op1", true))
        db.palletLabelTemplateDao().replaceAll(
            listOf(PalletLabelTemplateEntity(PalletLabelTemplateEntity.ORG, """{"a":1}"""), PalletLabelTemplateEntity(PalletLabelTemplateEntity.category(3), """{"b":2}""")),
        )
        val transport = routes(
            "/v1/device/org/print" to listOf(ok(HostFactsFixtures.fixture("org-print.json").toString())),
            "/v1/device/sscc/blocks" to listOf(ok("""{"id":"6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b","issuerPrefix":"460068200","extension":1,"fromSerial":40,"toSerial":239}""")),
            "/v1/device/box-registry" to listOf(ok("""{"until":"2026-10-08T07:30:00Z","items":[],"restoreEpoch":"e1"}""")),
        )
        val api = HostApi(transport)
        val meta = MetaStore(db)
        val pool = SsccPool(db)
        val backend = HostBackend(
            { api }, db.deviceConfigDao(), db, HostBlockSupplier(db, meta, api, pool, SsccBlockApplier(pool)), HostCalls { }, null, db.operatorDao(),
            HostOrgPrint(api, meta), HostBoxRegistry(db, meta, api),
        )
        val bootstrap = backend.palletBootstrap()
        assertEquals(listOf("p1"), bootstrap.products.map { it.id })
        assertEquals(40, bootstrap.products.single().palletBoxCapacity)
        assertEquals(listOf("op1"), bootstrap.operators.map { it.employeeId })
        assertEquals(listOf(3), bootstrap.palletLabelTemplates.byCategory.map { it.chzProductGroupCode })
        assertNotNull(bootstrap.palletLabelTemplates.organisation)
        val block = bootstrap.palletSscc!!
        assertEquals(Triple("460068200", 1, "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b"), Triple(block.issuerPrefix, block.extensionDigit, block.blockId))
        // the organization's print identity is kept for the labels
        assertEquals("ООО «Атолл»", HostOrgPrint(api, meta).cached()!!.name)
        assertEquals("e1", meta.get(HostBoxRegistry.EPOCH_KEY))
    }
}
