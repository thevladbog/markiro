package app.markiro.handheld.feature.shift

import app.markiro.handheld.core.storage.initializeRecoveryForTest
import app.markiro.handheld.core.storage.reconnectSameDeviceForTest
import app.markiro.handheld.core.storage.RecoveryBlocked
import app.markiro.handheld.MainDispatcherRule
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.advanceUntilIdle
import org.junit.Rule
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.box.BoxPrint
import app.markiro.handheld.core.box.ClosePallet
import app.markiro.handheld.core.box.ClosePalletResult
import app.markiro.handheld.core.box.PalletLock
import app.markiro.handheld.core.box.PalletRepository
import app.markiro.handheld.core.box.ServerRange
import app.markiro.handheld.core.box.Sscc
import app.markiro.handheld.core.box.SsccPool
import app.markiro.handheld.core.network.NetworkModule
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.BoxEntity
import app.markiro.handheld.core.storage.DeviceConfigEntity
import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class ShiftRepositoryTest {
    @get:Rule val main = MainDispatcherRule()
    private lateinit var db: HandheldDatabase
    private lateinit var server: MockWebServer
    private lateinit var api: StationApi
    private var clock = 1_757_500_000_000L

    private val shiftJson = """{"id":"s1","number":"SEP26-001","status":"planned","mode":"validation","validationPrint":{"mode":"none"},
        "productId":"p1","productName":"Вода","productPrintName":null,"lineId":"l1","lineName":"Линия 2","counterpartyName":null,
        "plannedQty":100,"plannedDate":"2026-09-10","productionDate":null,"boxCapacity":null,"palletBoxCapacity":null,"palletsEnabled":false,
        "openedAt":null,"closedAt":null,"stationCloseAccess":{"kind":"admin_only"}}"""
    private val activeShiftJson = shiftJson.replace("\"status\":\"planned\"", "\"status\":\"active\"")
    private val bundleJson = """{"shift":$activeShiftJson,
        "product":{"id":"p1","gtin14":"04600682000013","name":"Вода 0,5","printName":"Вода"},
        "labelTemplate":null,"boxLabelTemplate":null,"counterpartyGln":null,"sscc":null,"ssccRevokedFrom":[],
        "operators":[{"operatorId":"op-1","name":"Иванова Анна","login":"4127","role":"operator","pinHash":"x","badgeHash":null,"active":true}]}"""

    private val aggregationShiftJson = activeShiftJson
        .replace("\"mode\":\"validation\"", "\"mode\":\"aggregation\"")
        .replace("\"boxCapacity\":null", "\"boxCapacity\":20")

    /**
     * An aggregation shift as the server sends it: a box template and a serial
     * block. `ssccRevokedFrom` names a LOWER block than the one carried here --
     * a bundle never asks a device to drop the range it is itself naming, and
     * the fixture must not conflate the two.
     */
    private val aggregationBundleJson = """{"shift":$aggregationShiftJson,
        "product":{"id":"p1","gtin14":"04600682000013","name":"Вода 0,5","printName":"Вода","shelfLifeDays":365,"egaisCode":null},
        "labelTemplate":null,
        "boxLabelTemplate":{"id":"t1","name":"Коробка 58×40","spec":{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[]}},
        "counterpartyGln":null,"palletLabelTemplate":null,
        "sscc":{"issuerPrefix":"468008990","extensionDigit":0,"fromSerial":101,"toSerial":1000,"consumedThroughSerial":100},
        "ssccRevokedFrom":[1],"palletSscc":null,"palletSsccRevokedFrom":[],"operators":[]}"""

    private val palletShiftJson = aggregationShiftJson
        .replace("\"palletBoxCapacity\":null", "\"palletBoxCapacity\":20")
        .replace("\"palletsEnabled\":false", "\"palletsEnabled\":true")

    /**
     * Pallets OFF, but `palletBoxCapacity` populated anyway -- exactly what
     * `GET /shifts` legitimately sends once a product has prefilled it
     * (migration 0137) and pallets were never turned on for this shift. The
     * cabinet needs the raw column, so the server does not gate it; the
     * device must.
     */
    private val listOnlyPalletCapacityJson = aggregationShiftJson
        .replace("\"palletBoxCapacity\":null", "\"palletBoxCapacity\":12")

    /**
     * A pallets-enabled shift as the server sends it (06d): a SECOND serial
     * block on extension digit 1 and a pallet label template, alongside the box
     * pair. See `apps/api/src/modules/shifts/dto.ts`.
     */
    private val palletBundleJson = """{"shift":$palletShiftJson,
        "product":{"id":"p1","gtin14":"04600682000013","name":"Вода 0,5","printName":"Вода","shelfLifeDays":365,"egaisCode":null},
        "labelTemplate":null,
        "boxLabelTemplate":{"id":"t1","name":"Коробка 58×40","spec":{"widthMm":58,"heightMm":40,"dpi":203,"language":"zpl","elements":[]}},
        "palletLabelTemplate":{"id":"t2","name":"Паллета 100×150","spec":{"widthMm":100,"heightMm":150,"dpi":203,"language":"zpl","elements":[]}},
        "counterpartyGln":null,
        "sscc":{"issuerPrefix":"468008990","extensionDigit":0,"fromSerial":101,"toSerial":1000,"consumedThroughSerial":100},
        "ssccRevokedFrom":[1],
        "palletSscc":{"issuerPrefix":"468008990","extensionDigit":1,"fromSerial":1,"toSerial":500,"consumedThroughSerial":null},
        "palletSsccRevokedFrom":[],"operators":[]}"""

    /**
     * The same shift re-fetched after an admin reseeded BOTH counters back to a
     * value already seeded before, so each stream's revocation list repeats the
     * `fromSerial` of the very block the same bundle is handing out.
     */
    private val reissuedBundleJson = palletBundleJson
        .replace("\"ssccRevokedFrom\":[1],", "\"ssccRevokedFrom\":[1,101],")
        .replace("\"palletSsccRevokedFrom\":[]", "\"palletSsccRevokedFrom\":[1,201]")
        .replace(
            """"palletSscc":{"issuerPrefix":"468008990","extensionDigit":1,"fromSerial":1,"toSerial":500,"consumedThroughSerial":null}""",
            """"palletSscc":{"issuerPrefix":"468008990","extensionDigit":1,"fromSerial":201,"toSerial":700,"consumedThroughSerial":null}""",
        )

    /** A validation shift whose policy prints a duplicate, as the server sends it. */
    private val duplicateShiftJson = activeShiftJson.replace(
        """"validationPrint":{"mode":"none"}""",
        """"validationPrint":{"mode":"duplicate_dm","verification":"required","allowPreviouslyAcceptedCodes":true,"templateId":"dt1",""" +
            """"policyRevision":"rev-1","snapshot":{"id":"dt1","name":"Дубликат 30×20",""" +
            """"spec":{"widthMm":30,"heightMm":20,"dpi":203,"language":"zpl","elements":[]},"digest":"abc"}}""",
    )

    private val duplicateBundleJson = """{"shift":$duplicateShiftJson,
        "product":{"id":"p1","gtin14":"04600682000013","name":"Вода 0,5","printName":"Вода","shelfLifeDays":365,"egaisCode":null},
        "labelTemplate":null,"boxLabelTemplate":null,"counterpartyGln":null,"sscc":null,"ssccRevokedFrom":[],"operators":[]}"""

    @Before
    fun setUp() = runTest {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), HandheldDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        server = MockWebServer().also { it.start() }
        api = Retrofit.Builder().baseUrl(server.url("/")).client(OkHttpClient())
            .addConverterFactory(NetworkModule.json().asConverterFactory("application/json".toMediaType()))
            .build()
            .create(StationApi::class.java)
        db.deviceConfigDao().upsert(
            DeviceConfigEntity(
                deviceId = "dev-1", deviceName = "ТСД 1", tenantId = "t", organizationName = "ООО", lineId = "l1", lineName = "Линия 2",
                kind = "handheld", serverUrl = "http://x", pairedAt = 1L,
            ),
        )
        db.initializeRecoveryForTest()
    }

    @After
    fun tearDown() {
        main.cancelAndJoinModels()
        server.shutdown()
        db.close()
    }

    private fun repo() = ShiftRepository(api, db, NetworkModule.json(), SsccPool(db)) { clock }

    @Test
    fun refreshStoresTheListAndDropsVanishedListOnlyRows() = runTest {
        server.enqueue(MockResponse().setBody("""{"items":[$shiftJson]}"""))
        assertTrue(repo().refreshList())
        assertEquals("/shifts", server.takeRequest().path)
        assertEquals(listOf("s1"), db.shiftDao().observeAll().first().map { it.id })
        server.enqueue(MockResponse().setBody("""{"items":[]}"""))
        assertTrue(repo().refreshList())
        assertTrue(db.shiftDao().observeAll().first().isEmpty())
    }

    @Test
    fun enterRecordsParticipationStoresTheBundleAndActiveShiftButLeavesTheRosterAlone() = runTest {
        server.enqueue(MockResponse().setBody(activeShiftJson))
        server.enqueue(MockResponse().setBody(bundleJson))
        assertEquals(EnterResult.Ok, repo().enter("s1"))
        assertEquals("/shifts/s1/enter", server.takeRequest().path)
        assertEquals("/shifts/s1/bundle", server.takeRequest().path)
        val shift = db.shiftDao().get("s1")
        assertEquals("04600682000013", shift?.productGtin14)
        assertEquals("active", shift?.status)
        assertNotNull(shift?.bundleFetchedAt)
        assertEquals("s1", db.deviceConfigDao().get()?.activeShiftId)
        // Pairing and the roster refresh own the operators mirror; the bundle's copy is ignored as on the station.
        assertTrue(db.operatorDao().all().isEmpty())
    }

    @Test
    fun refreshKeepsAShiftClosedOnThisDeviceClosed() = runTest {
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(status = "closed"))
        server.enqueue(MockResponse().setBody("""{"items":[$activeShiftJson]}"""))
        assertTrue(repo().refreshList())
        assertEquals("closed", db.shiftDao().get("s1")?.status)
    }

    @Test
    fun updateRequiredAndClosedAreDistinguished() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"STATION_UPDATE_REQUIRED","message":"x"}"""))
        assertEquals(EnterResult.UpdateRequired, repo().enter("s1"))
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"message":"Closed shifts cannot be entered"}"""))
        assertEquals(EnterResult.Closed, repo().enter("s1"))
    }

    /**
     * Every conflict used to become «смена уже закрыта». An operator then stood
     * in front of a shift the cabinet still lists as open, with nothing on
     * screen naming the subscription that actually refused them.
     */
    @Test
    fun aConflictCarryingACodeIsNotReportedAsAClosedShift() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"subscription_unmanaged","statusCode":409}"""))
        assertEquals(EnterResult.Refused(EnterStep.ENTER, 409, "subscription_unmanaged"), repo().enter("s1"))
    }

    /** A refusal that is not a conflict at all was reported as «сервер недоступен». */
    @Test
    fun aForbiddenEntryNamesTheServersOwnCode() = runTest {
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"code":"subscription_read_only","statusCode":403}"""))
        assertEquals(EnterResult.Refused(EnterStep.ENTER, 403, "subscription_read_only"), repo().enter("s1"))
    }

    /**
     * The device is a participant server-side but has no data to work with. That
     * is a different fact from a closed shift, and the two were reported the
     * same because one `catch` covered both calls.
     */
    @Test
    fun aBundleRefusalIsReportedAgainstTheBundleAndEntersNothing() = runTest {
        server.enqueue(MockResponse().setBody(activeShiftJson))
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"message":"Shift product missing"}"""))
        assertEquals(EnterResult.Refused(EnterStep.BUNDLE, 404, null), repo().enter("s1"))
        assertNull(db.deviceConfigDao().get()?.activeShiftId)
        assertNull(db.shiftDao().get("s1"))
    }

    @Test
    fun offlineEntryWorksOnlyWithABundle() = runTest {
        server.shutdown()
        assertEquals(EnterResult.Unavailable, repo().enter("s1"))
        db.shiftDao().upsert(ShiftEntityFixtures.bundled("s1").copy(leftAt = 5L))
        assertEquals(EnterResult.Ok, repo().enter("s1"))
        assertNull(db.shiftDao().get("s1")?.leftAt)
        assertEquals("s1", db.deviceConfigDao().get()?.activeShiftId)
    }

    @Test
    fun enteringAnAggregationShiftStoresItsBlockAndTemplate() = runTest {
        server.enqueue(MockResponse().setBody(aggregationShiftJson))
        server.enqueue(MockResponse().setBody(aggregationBundleJson))
        assertEquals(EnterResult.Ok, repo().enter("s1"))
        val shift = db.shiftDao().get("s1")!!
        assertEquals("468008990", shift.ssccIssuerPrefix)
        assertEquals(365, shift.shelfLifeDays)
        assertTrue(shift.boxLabelTemplate!!.contains("\"widthMm\""))
        // The block lands at its ORIGINAL bounds, advanced past what the server
        // already recorded as consumed.
        assertEquals(101L, SsccPool(db).burn("468008990", 0))
    }

    @Test
    fun aRevokedBlockIsDroppedBeforeTheReplacementIsApplied() = runTest {
        val pool = SsccPool(db)
        pool.addRange(ServerRange("468008990", 0, 1, 50, null))
        server.enqueue(MockResponse().setBody(aggregationShiftJson))
        server.enqueue(MockResponse().setBody(aggregationBundleJson))
        repo().enter("s1")
        // Burning picks the lowest fromSerial with room, so a revoked range left
        // in place would keep winning over the block the admin just cut.
        assertEquals(101L, pool.burn("468008990", 0))
    }

    @Test
    fun enteringADuplicateShiftStoresItsPolicy() = runTest {
        server.enqueue(MockResponse().setBody(duplicateShiftJson))
        server.enqueue(MockResponse().setBody(duplicateBundleJson))
        server.enqueue(MockResponse().setResponseCode(404))
        assertEquals(EnterResult.Ok, repo().enter("s1"))
        val shift = db.shiftDao().get("s1")!!
        assertEquals("duplicate_dm", shift.validationPrintMode)
        assertTrue(shift.allowPreviouslyAcceptedCodes)
        assertEquals("required", shift.duplicateVerification)
        assertEquals("abc", shift.duplicateTemplateDigest)
        assertEquals("rev-1", shift.duplicatePolicyRevision)
        assertTrue(shift.duplicateTemplate!!.contains("\"widthMm\""))
    }

    @Test
    fun refreshingTheListKeepsTheDuplicatePolicy() = runTest {
        // Same trap as the SSCC issuer and the box template: the list carries no
        // policy, so rebuilding the row from it would strip one off a shift
        // already entered, and every later unit would refuse to print with
        // nothing on screen connecting that to a list refresh.
        server.enqueue(MockResponse().setBody(duplicateShiftJson))
        server.enqueue(MockResponse().setBody(duplicateBundleJson))
        server.enqueue(MockResponse().setResponseCode(404))
        assertEquals(EnterResult.Ok, repo().enter("s1"))

        server.enqueue(MockResponse().setBody("""{"items":[$duplicateShiftJson]}"""))
        assertTrue(repo().refreshList())

        val shift = db.shiftDao().get("s1")!!
        assertEquals("required", shift.duplicateVerification)
        assertEquals("abc", shift.duplicateTemplateDigest)
        assertEquals("rev-1", shift.duplicatePolicyRevision)
        assertNotNull(shift.duplicateTemplate)
    }

    @Test
    fun refreshingTheListKeepsWhatOnlyTheBundleCarries() = runTest {
        // The list has no SSCC issuer and no box template. Rebuilding the row from
        // it silently stripped both off a shift already entered, and boxes stopped
        // closing with nothing on screen connecting that to a list refresh.
        server.enqueue(MockResponse().setBody(aggregationShiftJson))
        server.enqueue(MockResponse().setBody(aggregationBundleJson))
        assertEquals(EnterResult.Ok, repo().enter("s1"))

        server.enqueue(MockResponse().setBody("""{"items":[$aggregationShiftJson]}"""))
        assertTrue(repo().refreshList())

        val shift = db.shiftDao().get("s1")!!
        assertEquals("468008990", shift.ssccIssuerPrefix)
        assertEquals(365, shift.shelfLifeDays)
        assertNotNull(shift.boxLabelTemplate)
        assertEquals("04600682000013", shift.productGtin14)
        // The bundle resolves these from the product and the list never carries a
        // print name, so a refresh must not replace what gets printed.
        assertEquals("Вода 0,5", shift.productName)
        assertEquals("Вода", shift.productPrintName)
    }

    @Test
    fun refreshingTheListNeverTurnsOnThePalletGateForAPalletsOffShift() = runTest {
        // `CloseBox.kt` and `WorkViewModel.kt` both read this shift's
        // `palletBoxCapacity` column as THE pallets-on signal -- there is no
        // separate flag on that read path. `GET /shifts` returns the column
        // ungated (the cabinet needs the raw value), so storing it verbatim
        // would flip that local signal on for a shift whose pallets are off,
        // and the device would show the full-screen pallet refusal overlay
        // for a shift that never asked for one.
        server.enqueue(MockResponse().setBody("""{"items":[$listOnlyPalletCapacityJson]}"""))
        assertTrue(repo().refreshList())

        val shift = db.shiftDao().get("s1")!!
        assertFalse(shift.palletsEnabled)
        assertNull(shift.palletBoxCapacity)
    }

    // -- The pallet stream (06d). Nothing below seeds a pool row or a template
    // by hand: the only way either reaches the device is a bundle arriving. --

    @Test
    fun aPalletsBundleLeavesTheDeviceAbleToActuallyCloseAPallet() = runTest {
        server.enqueue(MockResponse().setBody(palletShiftJson))
        server.enqueue(MockResponse().setBody(palletBundleJson))
        assertEquals(EnterResult.Ok, repo().enter("s1"))

        // The pallet block is a SECOND, independent block. Applying only the box
        // one leaves the device joining boxes to a pallet it can never number,
        // so every close from the capacity-th box onward refuses with NoSerials.
        val pool = SsccPool(db)
        val palletLock = PalletLock(db)
        val pallets = PalletRepository(db, palletLock) { clock }
        val pallet = pallets.currentPallet("s1")
        db.boxDao().insert(
            BoxEntity(
                boxId = "b1", shiftId = "s1", sscc = "046800899000000018",
                openedAt = "2026-09-11T07:00:00.000Z", closedAt = "2026-09-11T08:00:00.000Z",
                operatorId = "op1", printState = BoxPrint.PENDING, printReason = null, ackedAt = null,
                palletId = pallet.palletId,
            ),
        )
        val shift = db.shiftDao().get("s1")!!
        val closed = ClosePallet(db, pool, palletLock) { clock }
            .close("s1", shift.ssccIssuerPrefix, "op1") as ClosePalletResult.Closed
        // Extension digit 1: the leading character of a pallet SSCC, and a
        // number cut from the block the bundle itself delivered.
        assertEquals('1', closed.sscc.first())
        assertEquals(Sscc.build(SsccPool.PALLET_EXTENSION_DIGIT, "468008990", 1), closed.sscc)
        // The box stream is untouched by any of it.
        assertEquals(101L, pool.burn("468008990", SsccPool.BOX_EXTENSION_DIGIT))
    }

    @Test
    fun aPalletsBundleStoresThePalletTemplateAndARefreshDoesNotWipeIt() = runTest {
        // Without the template every pallet label refuses with `template_missing`,
        // and the list carries no template at all -- the same trap the box
        // template and the SSCC issuer already had.
        server.enqueue(MockResponse().setBody(palletShiftJson))
        server.enqueue(MockResponse().setBody(palletBundleJson))
        assertEquals(EnterResult.Ok, repo().enter("s1"))
        assertTrue(db.shiftDao().get("s1")!!.palletLabelTemplateSpec!!.contains("\"heightMm\":150"))

        server.enqueue(MockResponse().setBody("""{"items":[$palletShiftJson]}"""))
        assertTrue(repo().refreshList())

        val shift = db.shiftDao().get("s1")!!
        assertTrue(shift.palletLabelTemplateSpec!!.contains("\"heightMm\":150"))
        assertNotNull(shift.boxLabelTemplate)
        assertTrue(shift.palletsEnabled)
        assertEquals(20, shift.palletBoxCapacity)
    }

    @Test
    fun neitherStreamDropsTheBlockTheSameBundleIsNaming() = runTest {
        // Two blocks can share a `fromSerial` -- a revoked one and the
        // replacement cut after an admin reseeded the counter back to a value
        // already seeded before -- so a revocation list can repeat the
        // `fromSerial` of the block being handed out. Deleting that row takes
        // the local cursor with it, and the rebuilt one starts from the
        // server's `consumedThroughSerial`, still null while this device's
        // printed labels sit unsent: the next burn reissues serials already on
        // physical labels, which no later sync repairs.
        val pool = SsccPool(db)
        pool.addRange(ServerRange("468008990", SsccPool.BOX_EXTENSION_DIGIT, 1, 100, null))
        pool.addRange(ServerRange("468008990", SsccPool.BOX_EXTENSION_DIGIT, 101, 1000, 200))
        pool.addRange(ServerRange("468008990", SsccPool.PALLET_EXTENSION_DIGIT, 1, 200, null))
        pool.addRange(ServerRange("468008990", SsccPool.PALLET_EXTENSION_DIGIT, 201, 700, 250))

        server.enqueue(MockResponse().setBody(palletShiftJson))
        server.enqueue(MockResponse().setBody(reissuedBundleJson))
        assertEquals(EnterResult.Ok, repo().enter("s1"))

        // The genuinely revoked lower block is gone from both streams -- burning
        // picks the lowest `fromSerial` with room, so leaving it would keep
        // winning over the replacement. The named block keeps its own advanced
        // cursor instead of restarting at its lower bound.
        assertEquals(201L, pool.burn("468008990", SsccPool.BOX_EXTENSION_DIGIT))
        assertEquals(251L, pool.burn("468008990", SsccPool.PALLET_EXTENSION_DIGIT))
    }

    @Test fun delayedBundleCannotReplaceSavedShiftOrSsccPoolUnderNewGeneration() = runTest {
        val original = ShiftEntityFixtures.bundled("s1").copy(leftAt = 17L)
        db.shiftDao().upsert(original)
        val requested = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        api = object : StationApi by api {
            override suspend fun enter(id: String) = NetworkModule.json().decodeFromString<app.markiro.handheld.core.network.ShiftDto>(activeShiftJson)
            override suspend fun bundle(id: String): app.markiro.handheld.core.network.ShiftBundleDto {
                requested.complete(Unit)
                finish.await()
                return NetworkModule.json().decodeFromString(aggregationBundleJson)
            }
        }
        val entering = async { runCatching { repo().enter("s1") } }
        requested.await()
        db.recovery.reject(db.recovery.token())
        db.reconnectSameDeviceForTest()
        finish.complete(Unit)
        assertTrue(entering.await().exceptionOrNull() is RecoveryBlocked)
        assertEquals(original, db.shiftDao().get("s1"))
        assertNull(db.deviceConfigDao().get()?.activeShiftId)
        assertEquals(0L, db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM sscc_pool").use { it.moveToFirst(); it.getLong(0) })
    }

    @Test fun delayedNetworkFailureCannotEnterCachedShiftUnderNewGeneration() = runTest {
        val original = ShiftEntityFixtures.bundled("s1").copy(leftAt = 17L)
        db.shiftDao().upsert(original)
        val requested = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        api = object : StationApi by api {
            override suspend fun enter(id: String): app.markiro.handheld.core.network.ShiftDto {
                requested.complete(Unit)
                finish.await()
                throw java.io.IOException("synthetic offline")
            }
        }
        val entering = async { runCatching { repo().enter("s1") } }
        requested.await()
        db.recovery.reject(db.recovery.token())
        db.reconnectSameDeviceForTest()
        finish.complete(Unit)
        assertTrue(entering.await().exceptionOrNull() is RecoveryBlocked)
        assertEquals(original, db.shiftDao().get("s1"))
        assertNull(db.deviceConfigDao().get()?.activeShiftId)
    }

    @Test fun refusedEntryRefreshStaysBoundToTheInitiatingGeneration() = runTest {
        val cached = ShiftEntityFixtures.bundled("s1")
        db.shiftDao().upsert(cached)
        val requested = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        var listCalls = 0
        api = object : StationApi by api {
            override suspend fun shifts(status: String?, lineId: String?): app.markiro.handheld.core.network.ShiftListResponse {
                listCalls++
                return app.markiro.handheld.core.network.ShiftListResponse(emptyList())
            }
            override suspend fun enter(id: String): app.markiro.handheld.core.network.ShiftDto {
                requested.complete(Unit)
                finish.await()
                throw retrofit2.HttpException(retrofit2.Response.error<Any>(403,
                    """{"code":"subscription_read_only"}""".toResponseBody("application/json".toMediaType())))
            }
        }
        val vm = main.track(ShiftListViewModel(repo(), db.deviceConfigDao(), db.recovery, app.markiro.handheld.core.network.ReachabilityTracker(), flowOf(Unit)))
        vm.state.first { !it.loading }
        vm.select(cached)
        requested.await()
        db.recovery.reject(db.recovery.token())
        db.reconnectSameDeviceForTest()
        finish.complete(Unit)
        vm.state.first { it.dialog is ShiftDialog.Refused }
        advanceUntilIdle()
        assertEquals("The refusal refresh must not adopt the replacement credential", 1, listCalls)
        assertEquals(cached, db.shiftDao().get("s1"))
        assertNull(db.deviceConfigDao().get()?.activeShiftId)
    }

    @Test fun currentGenerationRefusalStillShowsServerReasonAndRefreshesTheList() = runTest {
        val cached = ShiftEntityFixtures.bundled("s1")
        db.shiftDao().upsert(cached)
        var listCalls = 0
        api = object : StationApi by api {
            override suspend fun shifts(status: String?, lineId: String?): app.markiro.handheld.core.network.ShiftListResponse {
                listCalls++
                return app.markiro.handheld.core.network.ShiftListResponse(emptyList())
            }
            override suspend fun enter(id: String): app.markiro.handheld.core.network.ShiftDto =
                throw retrofit2.HttpException(retrofit2.Response.error<Any>(403,
                    """{"code":"subscription_read_only"}""".toResponseBody("application/json".toMediaType())))
        }
        val vm = main.track(ShiftListViewModel(repo(), db.deviceConfigDao(), db.recovery, app.markiro.handheld.core.network.ReachabilityTracker(), flowOf(Unit)))
        vm.state.first { !it.loading }
        vm.select(cached)
        vm.state.first { it.dialog is ShiftDialog.Refused }
        advanceUntilIdle()
        assertEquals(ShiftDialog.Refused(EnterStep.ENTER, 403, "subscription_read_only"), vm.state.value.dialog)
        assertEquals(2, listCalls)
        assertEquals(cached, db.shiftDao().get("s1"))
        assertNull(db.deviceConfigDao().get()?.activeShiftId)
    }
}
