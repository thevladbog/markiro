package app.markiro.handheld.core.grants

import app.markiro.handheld.core.storage.HandheldDatabase
import kotlinx.serialization.json.*
import java.util.Base64

/** Storage-owner fixture; signature verification is exercised by GrantTransportTest. */
internal suspend fun installStrictShiftAuthority(db: HandheldDatabase, id: String) {
    val token=db.recovery.token(); val owner=token.owner.grantOwnerKey()
    db.grants.beginRefresh()
    db.grants.sample={ClockSample(100,"boot",1000)}
    db.grantDao().state(checkNotNull(db.grantDao().state()).copy(epoch=7,mode="strict",serverMs=1000,monotonicMs=100,bootId="boot",serverHighWater=1000,wallHighWater=1000,clockValid=true))
    val payload=buildJsonObject {
        put("version",1); put("issuer",token.owner.serverOrigin); put("grantId","owner-test"); put("tenantId",token.owner.tenantId); put("deviceId",token.owner.deviceId); put("kind","handheld"); put("credentialEpoch",7)
        put("entitlementRevision","e"); put("policyRevision","p"); put("issuedAt",900); put("notBefore",900); put("kindOfGrant","task"); put("taskKind","shift"); put("taskId",id); put("snapshotDigest","snapshot"); put("completeNotAfter",2000)
        val events=listOf("shift.scan.v1","shift.label.prepare.v1","shift.box.close.v1","shift.pallet.close.v1")
        put("eventTypes",JsonArray(events.map(::JsonPrimitive)))
        put("budget",JsonArray(events.flatMap { event -> (if(event.endsWith("close.v1")) listOf("events" to "event","containers" to "container") else listOf("events" to "event","units" to "unit")).map { (suffix,unit) -> buildJsonObject { put("id","$event:$suffix"); put("unit",unit); put("maximum",10) } } }))
    }
    fun encode(text: String)=Base64.getUrlEncoder().withoutPadding().encodeToString(text.toByteArray())
    val compact=encode("""{"typ":"markiro-offline-grant+jws","alg":"ES256","kid":"test"}""")+"."+encode(payload.toString())+"."+Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(64))
    db.grantDao().token(GrantTokenEntity(grantSlot(owner,"shift",id),owner,token.generation,7,"shift",id,"snapshot","test",compact))
    db.grantDao().binding(GrantTaskBindingEntity(owner,"shift",id,"snapshot","fixture",checkNotNull(GrantTaskMatcher.fingerprint(db,TaskKind.SHIFT,id))))
}
