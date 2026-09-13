package app.markiro.handheld.core.grants

import app.markiro.handheld.core.storage.DeviceOwner
import app.markiro.handheld.core.storage.RecoveryPhase
import app.markiro.handheld.core.storage.RecoveryState
import org.junit.Assert.assertEquals
import org.junit.Test

class GrantStatusTest {
    private val owner=DeviceOwner("https://example.test","tenant","device","handheld")
    private val session=RecoveryState(RecoveryPhase.ACTIVE,owner,1)
    private val state=GrantStateEntity(ownerKey=owner.grantOwnerKey(),generation=1,epoch=1,mode="strict",requestedSequence=1,installedSequence=1,
        keysetRevision="r",retiredKids="[]",keysetJson="{}",serverMs=1000,monotonicMs=100,bootId="boot",serverHighWater=1000,wallHighWater=1000,clockValid=true)
    private val sample=ClockSample(100,"boot",1000)

    @Test fun observeDiagnosticsNeverReportClockOrCredentialBlocking() {
        assertEquals(GrantStatus.OBSERVE,grantStatus(null,session,sample))
        assertEquals(GrantStatus.OBSERVE,grantStatus(state.copy(mode="observe",clockValid=false),session.copy(generation=2),sample.copy(bootId="new")))
    }

    @Test fun strictDiagnosticsDistinguishClockDistrustAndCredentialRefresh() {
        assertEquals(GrantStatus.STRICT,grantStatus(state,session,sample))
        assertEquals(GrantStatus.CLOCK_UNTRUSTED,grantStatus(state,session,sample.copy(bootId="new")))
        assertEquals(GrantStatus.CLOCK_UNTRUSTED,grantStatus(state,session,sample.copy(wallMs=900)))
        assertEquals(GrantStatus.REFRESH_REQUIRED,grantStatus(state,session.copy(generation=2),sample))
        assertEquals(GrantStatus.REFRESH_REQUIRED,grantStatus(state,session.copy(phase=RecoveryPhase.SEALED),sample))
    }
}
