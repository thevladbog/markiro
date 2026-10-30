package app.markiro.handheld.core.host

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.host.*
import app.markiro.handheld.core.storage.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class HostPackDisassemblyJournalTest {
    private val context:Context=ApplicationProvider.getApplicationContext()
    private val name="pack-intent-${UUID.randomUUID()}"
    private lateinit var db:HandheldDatabase
    private val credential=InMemoryCredentialStore()
    private val requests=mutableListOf<String>()
    private var timeout=true
    private var transportFailure:TransportFailure?=null
    private var responseOverride:String?=null
    private var beforeReply:suspend () -> Unit = {}
    private var responseStatus=200
    private val transport=object:HostTransport {
        override suspend fun get(path:String):HostResult=error("unexpected GET")
        override suspend fun post(path:String,body:String):HostResult {
            if(path.endsWith("lookup")) return HostResult.Ok(200,HostFactsFixtures.fixture("device-pack-inspection.json").toString(),null)
            requests+=body
            beforeReply()
            transportFailure?.let { return HostResult.Failed(it) }
            return if(timeout) HostResult.Failed(TransportFailure.TIMEOUT) else HostResult.Ok(responseStatus,responseOverride?:HostFactsFixtures.fixture("device-pack-disassembled.json").toString(),null)
        }
    }
    private fun open(){db=Room.databaseBuilder(context,HandheldDatabase::class.java,name).allowMainThreadQueries().build()}
    @Before fun setup()=runTest {
        open()
        val recovery=DeviceRecovery(db,credential);recovery.initialize()
        val origin="https://127.0.0.1:45710"
        recovery.restore(app.markiro.handheld.core.network.PairResponse(
            app.markiro.handheld.core.network.DeviceDto("dev-1","ТСД","handheld","host-1","Завод"),
            app.markiro.handheld.core.network.CredentialDto("test-key",origin),emptyList()),origin,HostPairing("a".repeat(64),"host-1",listOf("127.0.0.1")))
    }
    @After fun cleanup(){db.close();context.deleteDatabase(name)}
    private fun repository()=HostPackDisassembly(db,{ HostApi(transport) },HostCalls { },refresh={},nudge={})
    private fun inspection():InspectedPack {
        val token=db.recovery.token()
        return InspectedPack(Json.decodeFromJsonElement(PackInspectionDto.serializer(),HostFactsFixtures.fixture("device-pack-inspection.json")),token.owner,token.generation,null,operator)
    }
    private val operator="22222222-2222-4222-8222-222222222222"

    @Test fun timeoutThenDatabaseReopenRetriesExactlyTheOriginalIntent()=runTest {
        val first=repository();val card=inspection();val pending=first.prepare(card,card.reasons.single(),operator)
        try{first.submit(pending);fail("expected unknown result")}catch(_:PackDisassemblyFailure){}
        assertEquals(pending,first.pending());assertEquals(1,requests.size)
        db.close();open();DeviceRecovery(db,credential).initialize()
        val resumed=repository();assertEquals(pending,resumed.pending());assertTrue(resumed.canResume(pending,operator))
        timeout=false;val result=resumed.submit(pending)
        assertEquals("DSG-26-0001",result.docNo);assertEquals(requests[0],requests[1]);assertNull(resumed.pending())
    }
    @Test fun anotherPrepareNeverOverwritesAnUncertainIntent()=runTest {
        val repo=repository();val card=inspection();val pending=repo.prepare(card,card.reasons.single(),operator)
        try{repo.prepare(card.copy(data=card.data.copy(sscc="046012345600000016")),card.reasons.single(),operator);fail("must keep old intent")}catch(_:IllegalStateException){}
        assertEquals(pending,repo.pending());assertTrue(requests.isEmpty())
    }
    @Test fun datasetResetPreservesEvidenceAndNeverRebindsTheOldIntent()=runTest {
        val repo=repository();val card=inspection();val pending=repo.prepare(card,card.reasons.single(),operator)
        db.recovery.commit {
            clearHostDatasetBusinessTables(db)
            val cfg=checkNotNull(db.deviceConfigDao().get());db.deviceConfigDao().upsert(cfg.copy(hostDatasetEpoch="new-dataset"))
        }
        assertEquals(pending,repo.pending());assertFalse(repo.canResume(pending,operator))
        try{repo.submit(pending);fail("must not send old dataset intent")}catch(_:RecoveryBlocked){}
        assertTrue(requests.isEmpty())
        repo.archive(pending)
        assertNull(repo.pending());assertEquals(1,db.metaDao().withPrefix(HostPackDisassembly.EVIDENCE_PREFIX).size)
        db.recovery.commit { clearHostDatasetBusinessTables(db) }
        assertEquals(1,db.metaDao().withPrefix(HostPackDisassembly.EVIDENCE_PREFIX).size)
    }

    @Test fun anInspectionCannotBeReboundAfterDatasetReplacement()=runTest {
        val repo=repository();val inspected=repo.lookup("146012345600000006",operator)
        db.recovery.commit { val cfg=checkNotNull(db.deviceConfigDao().get());db.deviceConfigDao().upsert(cfg.copy(hostDatasetEpoch="replacement")) }
        try {repo.prepare(inspected,inspected.reasons.single(),operator);fail("old inspection must not bind to the replacement dataset")}catch(_:RecoveryBlocked){}
        assertNull(repo.pending());assertTrue(requests.isEmpty())
    }
    @Test fun aSuccessfulExternalPalletDisassemblyClearsKnownRegistryParentEvenWhenRefreshFails()=runTest {
        val card=inspection()
        db.boxRegistryDao().upsert(BoxRegistryEntity(sscc="046012345600000016",boxId="external-box",productId="p",bottleCount=12,contentKeysJson="[]",updatedAt="at",palletId="external-pallet",palletSscc=card.data.sscc,palletActive=true,localPalletId="other-pending-local"))
        val repo=HostPackDisassembly(db,{HostApi(transport)},HostCalls { },refresh={throw java.io.IOException("LAN down")},nudge={})
        val pending=repo.prepare(card,card.reasons.single(),operator);timeout=false;repo.submit(pending)
        val row=checkNotNull(db.boxRegistryDao().bySscc("046012345600000016"))
        assertFalse(row.palletActive==true);assertNull(row.palletSscc);assertEquals("other-pending-local",row.localPalletId);assertNull(repo.pending())
    }
    @Test fun aSuccessfulExternalBoxDisassemblyRemovesItsRegistryEntryEvenWhenRefreshFails()=runTest {
        val base=inspection();val card=base.copy(data=base.data.copy(sscc="046012345600000016",kind="box",boxes=1,units=12))
        db.boxRegistryDao().upsert(BoxRegistryEntity(sscc=card.data.sscc,boxId="external-box",productId="p",bottleCount=12,contentKeysJson="[]",updatedAt="at"))
        val repo=HostPackDisassembly(db,{HostApi(transport)},HostCalls { },refresh={throw java.io.IOException("LAN down")},nudge={})
        val pending=repo.prepare(card,card.reasons.single(),operator);timeout=false
        responseOverride="""{"documentId":"33333333-3333-4333-8333-333333333333","docNo":"DSG-26-0002","sscc":"${card.data.sscc}","kind":"box","boxes":1,"codes":12,"appliedAt":"2026-10-30T15:00:00Z"}"""
        repo.submit(pending)
        assertNull(db.boxRegistryDao().bySscc(card.data.sscc));assertNull(repo.pending())
    }

    @Test fun anInspectionCannotBeReboundToANewCredentialGeneration()=runTest {
        val repo=repository();val looked=repo.lookup("146012345600000006",operator);val old=db.recovery.token()
        db.recovery.reject(old)
        val origin="https://127.0.0.1:45710"
        db.recovery.restore(app.markiro.handheld.core.network.PairResponse(
            app.markiro.handheld.core.network.DeviceDto("dev-1","ТСД","handheld","host-1","Завод"),
            app.markiro.handheld.core.network.CredentialDto("new-test-key",origin),emptyList()),origin,HostPairing("a".repeat(64),"host-1",listOf("127.0.0.1")))
        assertTrue(db.recovery.token().generation>old.generation)
        try{repo.prepare(looked,looked.reasons.single(),operator);fail("old inspection must not acquire the new credential")}catch(_:RecoveryBlocked){}
        assertNull(repo.pending());assertTrue(requests.isEmpty())
    }
    @Test fun aLateKeyRefusalNamesTheGenerationCapturedBeforeTheNetworkCall()=runTest {
        val old=db.recovery.token();var current=old;var rejected:GenerationToken?=null
        val calls=HostCalls(generation={current},revocation={rejected=it})
        val repo=HostPackDisassembly(db,{HostApi(transport)},calls,refresh={},nudge={})
        val card=inspection();val pending=repo.prepare(card,card.reasons.single(),operator)
        timeout=false;responseStatus=401
        responseOverride="""{"error":{"code":"unauthorized","message":"test refusal","details":{"credential":"device"}}}"""
        beforeReply={current=old.copy(generation=old.generation+1)}
        try{repo.submit(pending);fail("expected key refusal")}catch(_:PackDisassemblyFailure){}
        assertEquals(old,rejected);assertEquals(pending,repo.pending())
    }
    @Test fun anUnreadableSavedBodyIsRetainedInsteadOfBeingOverwrittenOrRendered()=runTest {
        val repo=repository();val card=inspection();val pending=repo.prepare(card,card.reasons.single(),operator)
        val broken=pending.copy(body="{")
        db.recovery.commit { db.metaDao().put(MetaEntity(HostPackDisassembly.PENDING_KEY,Json.encodeToString(PendingPackDisassembly.serializer(),broken))) }
        try{repo.pending();fail("expected unreadable request")}catch(error:PackDisassemblyFailure){assertEquals("saved_unreadable",error.code)}
        assertNotNull(db.metaDao().get(HostPackDisassembly.PENDING_KEY));assertTrue(requests.isEmpty())
    }
    private suspend fun assertDefiniteRefusal(status:Int,code:String) {
        val repo=repository();val card=inspection();val pending=repo.prepare(card,card.reasons.single(),operator)
        timeout=false;responseStatus=status
        responseOverride="""{"error":{"code":"$code","message":"test refusal"}}"""
        try {repo.submit(pending);fail("expected definite refusal")}
        catch(error:PackDisassemblyFailure){assertEquals(code,error.code);assertFalse(error.uncertain)}
        assertNull(repo.pending());assertEquals(listOf(pending.body),requests)
    }
    @Test fun aForbiddenOperationReleasesItsPendingIntent()=runTest { assertDefiniteRefusal(403,"forbidden") }
    @Test fun anUnsupportedProtocolReleasesItsPendingIntent()=runTest { assertDefiniteRefusal(409,"protocol_unsupported") }

    @Test fun restoreOldHostAndUnreliableHttpAnswersKeepTheOriginalIntent()=runTest {
        val repo=repository();val card=inspection();val pending=repo.prepare(card,card.reasons.single(),operator)
        timeout=false
        for((status,code,expected) in listOf(Triple(503,"restore_pending","restore_hold"),Triple(404,"not_found","host_update"),Triple(500,"internal","unavailable"))) {
            responseStatus=status;responseOverride="""{"error":{"code":"$code","message":"test refusal"}}"""
            try{repo.submit(pending);fail("expected uncertain result")}
            catch(error:PackDisassemblyFailure){assertEquals(expected,error.code);assertTrue(error.uncertain)}
            assertEquals(pending,repo.pending())
        }
        responseStatus=200;responseOverride="not-json"
        try{repo.submit(pending);fail("expected unreadable response")}
        catch(error:PackDisassemblyFailure){assertTrue(error.uncertain)}
        assertEquals(pending,repo.pending());assertTrue(requests.all { it==pending.body })
    }
    @Test fun certificateAndTransportFailuresKeepTheOriginalIntent()=runTest {
        val repo=repository();val card=inspection();val pending=repo.prepare(card,card.reasons.single(),operator)
        for(failure in listOf(TransportFailure.CERT_MISMATCH,TransportFailure.TIMEOUT,TransportFailure.UNREACHABLE)) {
            transportFailure=failure
            try{repo.submit(pending);fail("expected uncertain result")}
            catch(error:PackDisassemblyFailure){assertEquals(if(failure==TransportFailure.CERT_MISMATCH) "certificate" else "unavailable",error.code);assertTrue(error.uncertain)}
            assertEquals(pending,repo.pending())
        }
        assertTrue(requests.all { it==pending.body })
    }

}
