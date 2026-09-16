package app.markiro.handheld.core.grants

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.mockwebserver.*
import okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AFTER_REQUEST
import okhttp3.mockwebserver.SocketPolicy.NO_RESPONSE
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(AndroidJUnit4::class)
class GrantTransportTest {
    private lateinit var activeOrigin: String
    private val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private fun b64(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    private fun keyset(origin: String, retired: List<String> = emptyList()) = buildJsonObject {
        put("protocol","offline-grants-v1"); put("origin",origin); put("revision","opaque-revision")
        put("retiredKids",JsonArray(retired.map(::JsonPrimitive)))
        val public = pair.public as ECPublicKey
        fun coordinate(bytes: ByteArray): String = b64(ByteArray(32).also { target -> val part=bytes.takeLast(32).toByteArray(); part.copyInto(target,32-part.size) })
        put("keys",JsonArray(listOf(buildJsonObject { put("kid","test"); put("jwk",buildJsonObject {
            put("kty","EC"); put("crv","P-256"); put("x",coordinate(public.w.affineX.toByteArray())); put("y",coordinate(public.w.affineY.toByteArray()))
        }) })))
    }
    private fun compact(owner: DeviceOwner, epoch: Long, time: Long, task: Pair<String,String>? = null): String {
        val header = b64("""{"typ":"markiro-offline-grant+jws","alg":"ES256","kid":"test"}""".toByteArray())
        val payload = b64(buildJsonObject {
            put("version",1); put("kindOfGrant",if(task == null) "device" else "task"); put("issuer",owner.serverOrigin); put("grantId","11111111-1111-4111-8111-${time.toString().padStart(12,'0')}"); put("tenantId",owner.tenantId); put("deviceId",owner.deviceId); put("kind","handheld"); put("credentialEpoch",epoch)
            put("entitlementRevision","e"); put("policyRevision","p-$time"); put("issuedAt",time); put("notBefore",time); if(task == null) {
                put("startNotAfter",time+10000); put("capabilities",JsonArray(listOf(JsonPrimitive("shift.start.v1"),JsonPrimitive("inventory.start.v1"))))
            } else {
                put("taskKind","inventory"); put("taskId",task.first); put("snapshotDigest",grantDigest(task.second)); put("completeNotAfter",time+100000)
                put("eventTypes",JsonArray(listOf(JsonPrimitive("inventory.scan.v1"))))
                put("budget",JsonArray(listOf("events" to "event","units" to "unit").map { (suffix,unit) -> buildJsonObject { put("id","inventory.scan.v1:$suffix"); put("unit",unit); put("maximum",10) } }))
            }
        }.toString().toByteArray())
        val signing = "$header.$payload"
        val der = Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(signing.toByteArray()); sign() }
        var offset=2
        fun integer(): ByteArray {
            require(der[offset++].toInt() == 2)
            val size=der[offset++].toInt() and 255
            val bytes=der.copyOfRange(offset,offset+size); offset+=size
            val part=bytes.takeLast(32).toByteArray()
            return ByteArray(32).also { part.copyInto(it,32-part.size) }
        }
        return "$signing.${b64(integer()+integer())}"
    }
    private fun envelope(owner: DeviceOwner, epoch: Long=7, time: Long=1000, mode: String="strict", grants: Boolean=true) = buildJsonObject {
        put("protocol","offline-grants-v1"); put("serverTime",time); put("mode",mode)
        put("owner",buildJsonObject { put("tenantId",owner.tenantId); put("deviceId",owner.deviceId); put("kind","handheld"); put("credentialEpoch",epoch) })
        put("grants",JsonArray(if(grants) listOf(JsonPrimitive(compact(owner,epoch,time))) else emptyList())); put("taskSnapshots",JsonArray(emptyList()))
    }
    private suspend fun database(origin: String): HandheldDatabase {
        activeOrigin = origin
        val db=Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(),HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.deviceConfigDao().upsert(syntheticDeviceConfig(origin)); DeviceRecovery(db,InMemoryCredentialStore().also { it.write("synthetic-key") }).initialize()
        db.grants.sample={ClockSample(100,"boot",1000)}
        return db
    }
    private fun api(server: MockWebServer): StationApi = Retrofit.Builder().baseUrl(server.url("/"))
        .client(OkHttpClient.Builder().retryOnConnectionFailure(false).build()).addConverterFactory(Json.asConverterFactory("application/json".toMediaType())).build().create(StationApi::class.java)
    private fun response(body: JsonObject): MockResponse {
        val result = if (body.containsKey("grants")) buildJsonObject { put("status", "issued"); put("envelope", body) } else body
        return MockResponse().setHeader("Content-Type","application/json").setBody(result.toString())
    }

    @Test fun waitingTargetPersistsStrictPolicyEvenWhenIssuanceIsDenied() = runTest {
        val server = MockWebServer(); server.start()
        val db = database(server.url("/").toString().trimEnd('/'))
        try {
            val token = db.recovery.token()
            val fence = app.markiro.handheld.core.network.ReplacementTargetFence(1, java.util.UUID.randomUUID().toString(), 7, 2000, 500)
            app.markiro.handheld.core.replacement.ReplacementTarget(db).persistPublication(token.owner, token.generation, fence)
            val wireFence = Json.encodeToJsonElement(app.markiro.handheld.core.network.ReplacementTargetFence.serializer(), fence.copy(serverTime = 1000))
            val config = configuration(envelope(token.owner))
            server.enqueue(response(JsonObject(config + ("replacement" to wireFence))))
            server.enqueue(response(buildJsonObject { put("status", "denied"); put("reason", "not_entitled") }))
            assertFalse(GrantTransport(db, api(server)).refreshIfAvailable())
            assertTrue(app.markiro.handheld.core.replacement.ReplacementReadiness(db).blocked())
            assertEquals("strict", db.grantDao().state()!!.mode)
        } finally { db.close(); server.shutdown() }
    }

    @Test fun retirementPersistsWhenIssuanceIsDeniedOrMalformed() = runTest {
        for (failure in listOf(response(buildJsonObject { put("status","denied"); put("reason","subscription_restricted") }), MockResponse().setResponseCode(403), response(buildJsonObject { put("status","issued"); put("envelope",buildJsonObject {}) }))) {
            val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
            try {
                val owner=db.recovery.token().owner; val transport=GrantTransport(db,api(server))
                server.enqueue(response(configuration(envelope(owner)))); server.enqueue(response(envelope(owner)))
                transport.refresh()
                val original=db.grantDao().token(grantSlot(owner.grantOwnerKey(),"device",""))!!.compact
                server.enqueue(response(configuration(envelope(owner),listOf("test")))); server.enqueue(failure)
                assertFalse(transport.refreshIfAvailable())
                assertEquals(JsonArray(listOf(JsonPrimitive("test"))).toString(),db.grantDao().state()!!.retiredKids)
                assertEquals(original,db.grantDao().token(grantSlot(owner.grantOwnerKey(),"device",""))!!.compact)
                assertTrue(runCatching { db.grants.start(TaskKind.SHIFT,"task","after-retirement") }.exceptionOrNull() is GrantDenied)
            } finally { db.close(); server.shutdown() }
        }
    }

    private fun configuration(envelope: JsonObject, retired: List<String> = emptyList(), policy: String? = "approved", withKeys: Boolean = true): JsonObject = buildJsonObject {
        put("protocol","offline-grants-v1"); put("owner",envelope.getValue("owner")); put("serverTime",envelope.getValue("serverTime")); put("mode",envelope.getValue("mode"))
        put("policyRevision",policy?.let(::JsonPrimitive) ?: JsonNull)
        put("keyset",if(withKeys) keyset(activeOrigin,retired) else JsonNull)
    }

    @Test fun lostReadinessResponseRetriesTheExactDurableBodyAfterGrantCommit() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        try {
            val owner=db.recovery.token().owner; val transport=GrantTransport(db,api(server))
            server.enqueue(response(configuration(envelope(owner))))
            server.enqueue(response(envelope(owner)))
            assertTrue(transport.refreshIfAvailable())
            val configurationRequest=checkNotNull(server.takeRequest(5,TimeUnit.SECONDS))
            val issuanceRequest=checkNotNull(server.takeRequest(5,TimeUnit.SECONDS))
            server.enqueue(MockResponse().setSocketPolicy(DISCONNECT_AFTER_REQUEST))
            assertFalse(transport.flushReadinessIfAvailable())
            val first=checkNotNull(server.takeRequest(5,TimeUnit.SECONDS))
            assertEquals("/station/grants/v1/configuration",configurationRequest.path)
            assertEquals("/station/grants/v1/device",issuanceRequest.path)
            assertEquals("/station/grants/v1/readiness",first.path)
            val firstBody=first.body.readUtf8()
            val body=Json.parseToJsonElement(firstBody).jsonObject
            assertEquals("offline-grants-readiness-v1",body["capability"]?.jsonPrimitive?.content)
            assertEquals("handheld:0.1.0",body["clientBuild"]?.jsonPrimitive?.content)
            assertEquals(HANDHELD_DATABASE_VERSION,body["storageRevision"]?.jsonPrimitive?.int)
            assertEquals("strict",body["installed"]?.jsonObject?.get("mode")?.jsonPrimitive?.content)
            assertEquals("approved",body["installed"]?.jsonObject?.get("policyRevision")?.jsonPrimitive?.content)
            assertEquals("opaque-revision",body["installed"]?.jsonObject?.get("keysetRevision")?.jsonPrimitive?.content)
            val requestId=body.getValue("requestId").jsonPrimitive.content
            assertEquals(requestId,db.grantDao().pendingReadiness(owner.grantOwnerKey(),1).single().requestId)
            server.enqueue(response(buildJsonObject {
                put("protocol","offline-grants-v1"); put("requestId","22222222-2222-4222-8222-222222222222"); put("receivedAt","2026-09-14T12:00:00.000Z")
                put("accepted",true); put("matchesCurrentConfiguration",true); put("verifiedGrantMatched",true)
            }))
            assertTrue(runCatching { transport.flushReadiness() }.exceptionOrNull() is IllegalArgumentException)
            assertEquals(requestId,db.grantDao().pendingReadiness(owner.grantOwnerKey(),1).single().requestId)
            server.enqueue(response(buildJsonObject {
                put("protocol","offline-grants-v1"); put("requestId",requestId); put("receivedAt","2026-09-14T12:00:00.000Z")
                put("accepted",true); put("matchesCurrentConfiguration",true); put("verifiedGrantMatched",true)
            }))
            assertTrue(transport.flushReadiness())
            val retry=checkNotNull(server.takeRequest(5,TimeUnit.SECONDS))
            assertEquals(firstBody,retry.body.readUtf8())
            assertTrue(db.grantDao().pendingReadiness(owner.grantOwnerKey(),1).isEmpty())
        } finally { db.close(); server.shutdown() }
    }

    @Test fun readinessCancellationStopsTheRefreshCoroutine() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        try {
            val owner=db.recovery.token().owner; val transport=GrantTransport(db,api(server))
            server.enqueue(response(configuration(envelope(owner))))
            server.enqueue(response(envelope(owner)))
            assertTrue(transport.refreshIfAvailable())
            server.takeRequest(5,TimeUnit.SECONDS); server.takeRequest(5,TimeUnit.SECONDS)
            server.enqueue(MockResponse().setSocketPolicy(NO_RESPONSE))
            val failure = runCatching {
                withTimeout(100) { transport.flushReadinessIfAvailable() }
            }.exceptionOrNull()
            assertTrue(failure is TimeoutCancellationException)
        } finally { db.close(); server.shutdown() }
    }

    @Test fun authenticatedConfigurationPersistsOnDenialAndOnlyApprovedPolicyCanRollbackStrict() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        try {
            val owner=db.recovery.token().owner; val transport=GrantTransport(db,api(server))
            val denial=buildJsonObject { put("status","denied"); put("reason","subscription_restricted") }
            server.enqueue(response(configuration(envelope(owner)))); server.enqueue(response(denial))
            assertFalse(transport.refreshIfAvailable())
            assertEquals("strict",db.grantDao().state()!!.mode)
            assertEquals(7L,db.grantDao().state()!!.epoch)
            assertEquals("/station/grants/v1/configuration",checkNotNull(server.takeRequest(5,TimeUnit.SECONDS)).path)
            checkNotNull(server.takeRequest(5,TimeUnit.SECONDS))
            server.enqueue(response(configuration(envelope(owner,time=1100,mode="observe"),policy=null,withKeys=false)))
            assertFalse(transport.refreshIfAvailable())
            assertEquals("strict",db.grantDao().state()!!.mode)
            server.enqueue(response(configuration(envelope(owner,time=1200,mode="observe"),retired=listOf("test"))))
            server.enqueue(response(denial))
            assertFalse(transport.refreshIfAvailable())
            assertEquals("observe",db.grantDao().state()!!.mode)
            assertEquals(JsonArray(listOf(JsonPrimitive("test"))).toString(),db.grantDao().state()!!.retiredKids)
            assertNull(db.grantDao().token(grantSlot(owner.grantOwnerKey(),"device","")))
        } finally { db.close(); server.shutdown() }
    }

    @Test fun absentPolicyCannotActivateStrictAndIssuedModeCannotOverrideApprovedConfiguration() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        try {
            val owner=db.recovery.token().owner; val transport=GrantTransport(db,api(server))
            server.enqueue(response(configuration(envelope(owner),policy=null,withKeys=false)))
            assertFalse(transport.refreshIfAvailable())
            assertEquals("observe",db.grantDao().state()!!.mode)
            server.enqueue(response(configuration(envelope(owner,time=1100,mode="observe"))))
            server.enqueue(response(envelope(owner,time=1100,mode="strict")))
            transport.refresh()
            assertEquals("observe",db.grantDao().state()!!.mode)
        } finally { db.close(); server.shutdown() }
    }

    @Test fun laterApprovedRollbackConfigurationWinsOverAnEarlierStrictIssuance() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        val arrived=CountDownLatch(1); val release=CountDownLatch(1); val configs=AtomicInteger(); val issues=AtomicInteger()
        try {
            val owner=db.recovery.token().owner
            server.dispatcher=object: okhttp3.mockwebserver.Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if(request.path!!.endsWith("configuration")) {
                        val first=configs.incrementAndGet()==1
                        return response(configuration(envelope(owner,time=if(first) 1000 else 1100,mode=if(first) "strict" else "observe")))
                    }
                    if(issues.incrementAndGet()==1) {
                        arrived.countDown(); check(release.await(15,TimeUnit.SECONDS))
                        return response(envelope(owner))
                    }
                    return MockResponse().setResponseCode(403)
                }
            }
            val transport=GrantTransport(db,api(server))
            val pending=async(Dispatchers.IO) { transport.refresh() }
            withContext(Dispatchers.IO) { check(arrived.await(15,TimeUnit.SECONDS)) }
            assertFalse(transport.refreshIfAvailable())
            release.countDown(); pending.await()
            assertEquals("observe",db.grantDao().state()!!.mode)
            assertEquals(1100L,db.grantDao().state()!!.serverHighWater)
            assertNull(db.grantDao().token(grantSlot(owner.grantOwnerKey(),"device","")))
        } finally { release.countDown(); db.close(); server.shutdown() }
    }

    @Test fun configurationRetirementSurvivesAnUntrustedTimeAnchor() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        try {
            val owner=db.recovery.token().owner; val transport=GrantTransport(db,api(server))
            server.enqueue(response(configuration(envelope(owner)))); server.enqueue(response(envelope(owner))); transport.refresh()
            db.grantDao().state(checkNotNull(db.grantDao().state()).copy(serverHighWater=5000))
            server.enqueue(response(configuration(envelope(owner,time=1100),retired=listOf("test")))); server.enqueue(MockResponse().setResponseCode(403))
            assertFalse(transport.refreshIfAvailable())
            assertEquals(JsonArray(listOf(JsonPrimitive("test"))).toString(),db.grantDao().state()!!.retiredKids)
            assertFalse(db.grantDao().state()!!.clockValid)
            assertEquals(5000L,db.grantDao().state()!!.serverHighWater)
        } finally { db.close(); server.shutdown() }
    }

    @Test fun boundedResponseUsesConservativeTimeWithoutBlockingValidAuthority() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        try {
            val owner=db.recovery.token().owner
            server.dispatcher=object: okhttp3.mockwebserver.Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if(request.path!!.endsWith("configuration")) return response(configuration(envelope(owner)))
                    db.grants.sample={ClockSample(200,"boot",1100)}
                    return response(envelope(owner))
                }
            }
            GrantTransport(db,api(server)).refresh()
            assertEquals(1100L,db.grantDao().state()!!.serverMs)
            db.grants.start(TaskKind.SHIFT,"task","bounded")
            assertEquals(1100L,db.grantDao().evidence().single().trustedTime)
        } finally { db.close(); server.shutdown() }
    }

    @Test fun responseElapsedTimeCannotExtendDeadlineAndBootChangeDeniesClock() = runTest {
        for (end in listOf(ClockSample(20100,"boot",21000),ClockSample(200,"new-boot",1100),ClockSample(200,"",1100),ClockSample(50,"boot",1100))) {
            val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
            try {
                val owner=db.recovery.token().owner
                server.dispatcher=object: okhttp3.mockwebserver.Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse {
                        if(request.path!!.endsWith("configuration")) return response(configuration(envelope(owner)))
                        db.grants.sample={end}
                        return response(envelope(owner))
                    }
                }
                GrantTransport(db,api(server)).refresh()
                assertEquals("strict",db.grantDao().state()!!.mode)
                assertTrue(runCatching { db.grants.start(TaskKind.SHIFT,"task","late") }.exceptionOrNull() is GrantDenied)
            } finally { db.close(); server.shutdown() }
        }
    }


    private suspend fun inventorySnapshot(db: HandheldDatabase, date: String = InventoryFixtures.task("i1").productionDateTo): String {
        db.inventoryTaskDao().upsert(InventoryFixtures.task("i1").copy(productionDateTo=date))
        val manifest=JsonObject(checkNotNull(GrantTaskMatcher.projection(db,TaskKind.INVENTORY,"i1")) + buildJsonObject {
            put("snapshotRevision",1); put("egaisCode",JsonNull); put("shelfLifeDays",JsonNull); put("boxLabelTemplate",JsonNull)
            put("limits",buildJsonObject { put("codePageSize",200); put("eventBatchSize",200); put("progressPageSize",200) })
        })
        db.grants.saveProvenance(TaskKind.INVENTORY,"i1",manifest.toString())
        return buildJsonObject { put("taskKind","inventory"); put("taskId","i1"); put("scope",buildJsonObject {
            put("manifest",manifest); listOf("snapshotId","combinedDigest","contentDigest").forEach { put(it,manifest.getValue(it)) }
        }) }.toString()
    }
    private fun taskEnvelope(owner: DeviceOwner, canonical: String, time: Long=1000, epoch: Long=7) = JsonObject(envelope(owner,time=time,epoch=epoch) + mapOf(
        "grants" to JsonArray(listOf(JsonPrimitive(compact(owner,epoch,time,"i1" to canonical)))),
        "taskSnapshots" to JsonArray(listOf(buildJsonObject { put("taskKind","inventory"); put("taskId","i1"); put("snapshotDigest",grantDigest(canonical)); put("canonical",canonical) }))
    ))

    @Test fun firstFrozenBindingRequiresCurrentAdmissionAndThenSurvivesDeviceExpiry() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        try {
            val owner=db.recovery.token().owner; val ownerKey=owner.grantOwnerKey(); val transport=GrantTransport(db,api(server))
            val canonical=inventorySnapshot(db)
            // Historical observe work and a local task do not authorize the first signed frozen scope.
            db.grants.complete(TaskKind.INVENTORY,"i1","legacy-scan",GrantEventType.INVENTORY_SCAN,units=1)
            server.enqueue(response(configuration(envelope(owner)))); server.enqueue(response(envelope(owner))); transport.refresh()
            repeat(2) {
                server.enqueue(response(configuration(taskEnvelope(owner,canonical,time=12000)))); server.enqueue(response(taskEnvelope(owner,canonical,time=12000)))
                assertFalse(transport.refreshIfAvailable(TaskKind.INVENTORY,"i1"))
                assertNull(db.grantDao().binding(ownerKey,"inventory","i1"))
                assertNull(db.grantDao().token(grantSlot(ownerKey,"inventory","i1")))
                assertEquals(listOf(1L,1L),db.grantDao().counters(ownerKey,"inventory","i1","unbound").map { it.consumed }.sorted())
            }
            server.enqueue(response(configuration(envelope(owner,time=12000)))); server.enqueue(response(envelope(owner,time=12000))); transport.refresh()
            server.enqueue(response(configuration(taskEnvelope(owner,canonical,time=12000)))); server.enqueue(response(taskEnvelope(owner,canonical,time=12000))); transport.refresh(TaskKind.INVENTORY,"i1")
            assertEquals(grantDigest(canonical),db.grantDao().binding(ownerKey,"inventory","i1")!!.snapshotDigest)
            assertEquals(listOf(1L,1L),db.grantDao().counters(ownerKey,"inventory","i1",grantDigest(canonical)).map { it.consumed }.sorted())
            // The device start deadline is 22000; the admitted task completion deadline remains 112000.
            db.grants.sample={ClockSample(11100,"boot",12000)}
            db.grants.complete(TaskKind.INVENTORY,"i1","offline-completion",GrantEventType.INVENTORY_SCAN,units=1)
            assertEquals(listOf(2L,2L),db.grantDao().counters(ownerKey,"inventory","i1",grantDigest(canonical)).map { it.consumed }.sorted())
        } finally { db.close(); server.shutdown() }
    }

    @Test fun realTaskResponseBindsAndChangedScopeRequiresCurrentNewWorkAuthority() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        try {
            val owner=db.recovery.token().owner; val transport=GrantTransport(db,api(server)); val ownerKey=owner.grantOwnerKey()
            server.enqueue(response(configuration(envelope(owner)))); server.enqueue(response(envelope(owner))); transport.refresh()
            val first=inventorySnapshot(db)
            server.enqueue(response(configuration(taskEnvelope(owner,first)))); server.enqueue(response(taskEnvelope(owner,first))); transport.refresh(TaskKind.INVENTORY,"i1")
            db.grants.complete(TaskKind.INVENTORY,"i1","scan",GrantEventType.INVENTORY_SCAN,units=1)
            val changed=inventorySnapshot(db,"2026-09-01")
            server.enqueue(response(configuration(taskEnvelope(owner,changed,time=12000)))); server.enqueue(response(taskEnvelope(owner,changed,time=12000)))
            assertFalse(transport.refreshIfAvailable(TaskKind.INVENTORY,"i1"))
            assertEquals(grantDigest(first),db.grantDao().binding(ownerKey,"inventory","i1")!!.snapshotDigest)
            assertEquals(listOf(1L,1L),db.grantDao().counters(ownerKey,"inventory","i1",grantDigest(first)).map { it.consumed }.sorted())
            // A task token cannot substitute for missing device authority.
            db.openHelper.writableDatabase.execSQL("DELETE FROM grant_tokens WHERE taskKind = 'device'")
            server.enqueue(response(configuration(taskEnvelope(owner,changed,time=12000)))); server.enqueue(response(taskEnvelope(owner,changed,time=12000)))
            assertFalse(transport.refreshIfAvailable(TaskKind.INVENTORY,"i1"))
            assertTrue(db.grantDao().evidence().any { it.reason == "MISSING_GRANT" })
            server.enqueue(response(configuration(envelope(owner,time=12000)))); server.enqueue(response(envelope(owner,time=12000))); transport.refresh()
            server.enqueue(response(configuration(taskEnvelope(owner,changed,time=12000)))); server.enqueue(response(taskEnvelope(owner,changed,time=12000))); transport.refresh(TaskKind.INVENTORY,"i1")
            assertEquals(grantDigest(changed),db.grantDao().binding(ownerKey,"inventory","i1")!!.snapshotDigest)
            assertTrue(db.grantDao().evidence().any { it.eventId.startsWith("task.binding:") && it.reason == null })
            db.grants.complete(TaskKind.INVENTORY,"i1","scan-new",GrantEventType.INVENTORY_SCAN,units=1)
            val evidenceCount=db.grantDao().evidence().size
            server.enqueue(response(configuration(taskEnvelope(owner,changed,time=13000)))); server.enqueue(response(taskEnvelope(owner,changed,time=13000))); transport.refresh(TaskKind.INVENTORY,"i1")
            assertEquals(evidenceCount,db.grantDao().evidence().size)
            server.enqueue(response(configuration(envelope(owner,time=14000,epoch=8)))); server.enqueue(response(envelope(owner,time=14000,epoch=8))); transport.refresh()
            server.enqueue(response(configuration(taskEnvelope(owner,changed,time=14000,epoch=8)))); server.enqueue(response(taskEnvelope(owner,changed,time=14000,epoch=8))); transport.refresh(TaskKind.INVENTORY,"i1")
            assertEquals(8L,db.grantDao().state()!!.epoch)
            assertEquals(evidenceCount,db.grantDao().evidence().size)
            assertEquals(listOf(1L,1L),db.grantDao().counters(ownerKey,"inventory","i1",grantDigest(changed)).map { it.consumed }.sorted())
        } finally { db.close(); server.shutdown() }
    }

    @Test fun authenticatedHigherEpochInstallsAndRetirementCannotBeUndone() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        try {
            val owner=db.recovery.token().owner; val transport=GrantTransport(db,api(server))
            server.enqueue(response(configuration(envelope(owner)))); server.enqueue(response(envelope(owner)))
            transport.refresh()
            assertEquals(7L,db.grantDao().state()?.epoch); assertEquals("strict",db.grantDao().state()?.mode)
            db.grants.start(TaskKind.SHIFT,"task","entry")
            server.enqueue(response(configuration(envelope(owner,time=1100),listOf("test")))); server.enqueue(response(buildJsonObject { put("status","denied"); put("reason","subscription_restricted") }))
            assertFalse(transport.refreshIfAvailable())
            server.enqueue(response(configuration(envelope(owner,time=1200)))); server.enqueue(response(envelope(owner,time=1200)))
            assertFalse(transport.refreshIfAvailable())
            assertEquals("[\"test\"]",db.grantDao().state()?.retiredKids)
            assertTrue(runCatching { db.grants.start(TaskKind.SHIFT,"other","other-entry") }.exceptionOrNull() is GrantDenied)
            assertTrue(db.grantDao().state()!!.keysetJson.contains("test"))
        } finally { db.close(); server.shutdown() }
    }

    @Test fun laterRequestWinsEvenWhenEarlierSameGenerationResponseArrivesLast() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        val firstArrived=CountDownLatch(1); val releaseFirst=CountDownLatch(1); val count=AtomicInteger()
        try {
            val owner=db.recovery.token().owner
            server.dispatcher=object: okhttp3.mockwebserver.Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if(request.path!!.endsWith("configuration")) return response(configuration(envelope(owner)))
                    return if(count.incrementAndGet()==1) {
                        firstArrived.countDown(); check(releaseFirst.await(15,TimeUnit.SECONDS)); response(envelope(owner,time=1000,mode="observe"))
                    } else response(envelope(owner,time=2000,mode="strict"))
                }
            }
            val transport=GrantTransport(db,api(server))
            val old=async(Dispatchers.IO) { transport.refresh() }
            withContext(Dispatchers.IO) { check(firstArrived.await(15,TimeUnit.SECONDS)) }
            transport.refresh()
            releaseFirst.countDown(); old.await()
            assertEquals("strict",db.grantDao().state()?.mode); assertEquals(2000L,db.grantDao().state()?.serverHighWater)
            assertEquals(2L,db.grantDao().state()?.installedSequence)
        } finally { releaseFirst.countDown(); db.close(); server.shutdown() }
    }

    @Test fun authenticatedAnchorRecoversWallRollbackAndPreservesConsumption() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        try {
            val owner=db.recovery.token().owner; val key=owner.grantOwnerKey(); val transport=GrantTransport(db,api(server))
            server.enqueue(response(configuration(envelope(owner)))); server.enqueue(response(envelope(owner)))
            transport.refresh()
            db.grantDao().counter(GrantCounterEntity(key,"shift","task","snapshot","shift.scan.v1:units",9))
            db.grants.sample={ClockSample(110,"boot",900)}
            assertTrue(runCatching { db.grants.start(TaskKind.SHIFT,"task","blocked") }.exceptionOrNull() is GrantDenied)
            assertFalse(db.grantDao().state()!!.clockValid)
            server.enqueue(response(configuration(envelope(owner,time=1100)))); server.enqueue(response(envelope(owner,time=1100)))
            transport.refresh()
            db.grants.start(TaskKind.SHIFT,"task","after-anchor")
            assertEquals(900L,db.grantDao().state()?.wallHighWater)
            assertEquals(9L,db.grantDao().counters(key,"shift","task","snapshot").single().consumed)
        } finally { db.close(); server.shutdown() }
    }

    @Test fun lateResponseCannotInstallAfterCredentialSealingAndRecovery() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        val arrived=CountDownLatch(1); val release=CountDownLatch(1)
        try {
            val token=db.recovery.token()
            server.dispatcher=object: okhttp3.mockwebserver.Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if(request.path!!.endsWith("configuration")) return response(configuration(envelope(token.owner)))
                    arrived.countDown(); check(release.await(15,TimeUnit.SECONDS)); return response(envelope(token.owner))
                }
            }
            val pending=async(Dispatchers.IO) { runCatching { GrantTransport(db,api(server)).refresh() } }
            withContext(Dispatchers.IO) { check(arrived.await(15,TimeUnit.SECONDS)) }
            db.recovery.reject(token); db.reconnectSameDeviceForTest()
            release.countDown()
            assertTrue(pending.await().exceptionOrNull() is RecoveryBlocked)
            assertEquals("strict",db.grantDao().state()?.mode)
            assertEquals(0L,db.grantDao().state()?.installedSequence)
            assertTrue(db.recovery.token().generation > token.generation)
        } finally { release.countDown(); db.close(); server.shutdown() }
    }

    @Test fun missingBootIdentityDoesNotDowngradeAuthenticatedStrictMode() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        try {
            val owner=db.recovery.token().owner
            db.grants.sample={ClockSample(100,"",1000)}
            server.enqueue(response(configuration(envelope(owner)))); server.enqueue(response(envelope(owner)))
            GrantTransport(db,api(server)).refresh()
            assertEquals("strict",db.grantDao().state()?.mode)
            assertFalse(db.grantDao().state()!!.clockValid)
            val denied=runCatching { db.grants.start(TaskKind.SHIFT,"task","no-boot") }.exceptionOrNull() as GrantDenied
            assertEquals("CLOCK_UNTRUSTED",denied.decision.reason)
        } finally { db.close(); server.shutdown() }
    }

    @Test fun otherTenantEnvelopeCannotPublishModeEpochOrAuthority() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        try {
            val owner=db.recovery.token().owner
            server.enqueue(response(configuration(envelope(owner)))); server.enqueue(response(envelope(owner.copy(tenantId="other"))))
            assertFalse(GrantTransport(db,api(server)).refreshIfAvailable())
            assertEquals("strict",db.grantDao().state()?.mode)
            assertEquals(7L,db.grantDao().state()?.epoch)
            assertNull(db.grantDao().token(grantSlot(owner.grantOwnerKey(),"device","")))
            assertTrue(db.grantDao().pendingReadiness(owner.grantOwnerKey(),1).isEmpty())
        } finally { db.close(); server.shutdown() }
    }
    @Test fun replacementFencesDelayedConfigurationAndGrantAcrossDurableCancellationAck() = runTest {
        for (stage in listOf("configuration", "grant")) for (startedWhilePending in listOf(false,true)) {
            val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
            val arrived=CountDownLatch(1); val release=CountDownLatch(1)
            try {
                val token=db.recovery.token(); val owner=token.owner
                val transport=GrantTransport(db,api(server))
                server.enqueue(response(configuration(envelope(owner)))); server.enqueue(response(envelope(owner)))
                transport.refresh()
                val local=app.markiro.handheld.core.replacement.ReplacementReadiness(db)
                val intent=Json.parseToJsonElement("""{"version":1,"state":"active","intent":{"intentId":"11111111-1111-4111-8111-111111111111","preparationId":"22222222-2222-4222-8222-222222222222","credentialEpoch":7,"preparationRevision":2,"requestedAt":"2026-09-16T00:00:00Z","expiresAt":"2026-09-17T00:00:00Z"}}""").jsonObject
                val closure=Json.parseToJsonElement("""{"version":1,"state":"cancelled","intentId":"11111111-1111-4111-8111-111111111111","preparationId":"22222222-2222-4222-8222-222222222222","credentialEpoch":7,"preparationRevision":3,"closedAt":"2026-09-16T01:00:00Z"}""").jsonObject
                if(startedWhilePending) { local.apply(token,intent); local.apply(token,closure) }
                server.dispatcher=object: okhttp3.mockwebserver.Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse {
                        val configuration=request.path!!.endsWith("configuration")
                        if(configuration == (stage == "configuration")) { arrived.countDown(); check(release.await(15,TimeUnit.SECONDS)) }
                        return if(configuration) response(configuration(envelope(owner,time=1200,mode="observe"))) else response(envelope(owner,time=1200,mode="observe"))
                    }
                }
                // Task refresh remains available while draining; it must not reopen device authority.
                val pending=async(Dispatchers.IO) { transport.refresh(TaskKind.SHIFT,"existing") }
                withContext(Dispatchers.IO) { check(arrived.await(15,TimeUnit.SECONDS)) }
                if(!startedWhilePending) { local.apply(token,intent); local.apply(token,closure) }
                val body=checkNotNull(local.pendingClosure(token))
                assertTrue(local.blocked())
                local.acknowledgeClosure(token,body,JsonObject(body+("acknowledgedAt" to JsonPrimitive("2026-09-16T01:00:01Z"))))
                release.countDown(); pending.await()
                assertFalse(local.blocked())
                assertNull(db.grantDao().token(grantSlot(owner.grantOwnerKey(),"device","")))
                // A response applied before drain can legitimately set mode; a delayed one cannot.
                if(stage == "configuration" || startedWhilePending) assertEquals("strict",db.grantDao().state()?.mode)
            } finally { release.countDown(); db.close(); server.shutdown() }
        }
    }

    @Test fun upgradingRoomDoesNotStrandAnOlderDurableGrantReadinessRequest() = runTest {
        val server=MockWebServer(); server.start(); val db=database(server.url("/").toString().trimEnd('/'))
        try {
            val token=db.recovery.token(); val transport=GrantTransport(db,api(server))
            val id="11111111-1111-4111-8111-111111111111"
            val body=buildJsonObject {
                put("protocol","offline-grants-v1"); put("capability","offline-grants-readiness-v1"); put("requestId",id)
                put("clientBuild","handheld:previous"); put("storageRevision",16)
                put("installed",buildJsonObject { put("mode","strict"); put("policyRevision","approved"); put("keysetRevision","keys"); put("verifiedGrantId",id) })
            }
            db.grantDao().readiness(GrantReadinessOutboxEntity(id,token.owner.grantOwnerKey(),token.generation,body.toString()))
            server.enqueue(response(buildJsonObject {
                put("protocol","offline-grants-v1"); put("requestId",id); put("receivedAt","2026-09-16T12:00:00Z")
                put("accepted",true); put("matchesCurrentConfiguration",true); put("verifiedGrantMatched",true)
            }))
            assertTrue(transport.flushReadinessIfAvailable())
            assertEquals(body.toString(),server.takeRequest().body.readUtf8())
        } finally { db.close(); server.shutdown() }
    }

}
