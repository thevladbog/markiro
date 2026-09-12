package app.markiro.handheld.feature.shift

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.markiro.handheld.core.network.*
import app.markiro.handheld.core.storage.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.HttpException
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.io.IOException

@RunWith(AndroidJUnit4::class)
class ValidationHistoryMirrorTest {
    private val json=Json { ignoreUnknownKeys=true }
    private val unusedApi=Retrofit.Builder().baseUrl("http://127.0.0.1/").client(OkHttpClient())
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType())).build().create(StationApi::class.java)
    private fun page(snapshot: String="a".repeat(64), cursor: String?=null, hash: String="b".repeat(64))=ValidationHistoryPage(
        VALIDATION_REPROCESSING_PROTOCOL,"s1","p1",snapshot,"2026-09-12T00:00:00Z","2026-09-12T01:00:00Z",cursor,cursor==null,
        listOf(ValidationHistoryItem(hash,"original","old","OLD-001","closed","2026-09-01T00:00:00Z")),
    )
    private suspend fun withDb(block: suspend (HandheldDatabase) -> Unit) {
        val db=Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(),HandheldDatabase::class.java).allowMainThreadQueries().build()
        db.initializeRecoveryForTest()
        try {
            db.validationDao().stage(listOf(ValidationHistoryEntity("previous","c".repeat(64),"original","old","OLD-001","closed","2026-09-01T00:00:00Z")))
            db.validationDao().publish(ValidationHistoryPublication("s1","p1","previous","c".repeat(64),"2026-09-11T00:00:00Z","2026-09-11T01:00:00Z"))
            block(db)
        } finally { db.close() }
    }
    @Test fun boundedPagesActivateOnlyAtCompletionAndPartialFailurePreservesPreviousCache() = runTest {
        for(fail in listOf(false,true)) withDb { db ->
            var calls=0
            val api=object: StationApi by unusedApi {
                override suspend fun codeHistory(id:String,cursor:String?,snapshot:String?,limit:Int):ValidationHistoryPage {
                    assertEquals(1000,limit)
                    assertEquals("previous",db.validationDao().publication("s1")?.publication)
                    calls++
                    if(calls==1) { assertNull(cursor); assertNull(snapshot); return page(cursor="next") }
                    assertEquals("next",cursor); assertEquals("a".repeat(64),snapshot)
                    if(fail) throw IOException("offline")
                    return page(hash="d".repeat(64))
                }
            }
            assertEquals(!fail,ValidationHistoryMirror(db,api,json).refresh("s1","p1"))
            assertEquals(2,calls)
            assertEquals(if(fail) "c".repeat(64) else "a".repeat(64),db.validationDao().publication("s1")?.snapshot)
            assertEquals(if(fail) 0 else 1,db.validationDao().history("s1","b".repeat(64)).size)
            db.openHelper.readableDatabase.query("SELECT COUNT(*) FROM validation_history").use { it.moveToFirst(); assertEquals(if(fail) 1 else 2,it.getInt(0)) }
        }
    }
    @Test fun onlyExactExpiryRestartsBoundedlyAndMixedSnapshotsNeverPublish() = runTest {
        for(scenario in listOf("expired","other409","mismatch","duplicate")) withDb { db ->
            var calls=0
            val api=object: StationApi by unusedApi {
                override suspend fun codeHistory(id:String,cursor:String?,snapshot:String?,limit:Int):ValidationHistoryPage {
                    calls++
                    if(calls==1) return page(cursor="next")
                    if(scenario=="mismatch") return page(snapshot="d".repeat(64))
                    if(scenario=="duplicate") return page()
                    if(calls==2) throw HttpException(Response.error<String>(409,"""{"code":"${if(scenario=="expired") "VALIDATION_HISTORY_EXPIRED" else "OTHER"}"}""".toResponseBody("application/json".toMediaType())))
                    assertNull(cursor); assertNull(snapshot)
                    return page(snapshot="e".repeat(64))
                }
            }
            assertEquals(scenario=="expired",ValidationHistoryMirror(db,api,json).refresh("s1","p1"))
            assertEquals(if(scenario=="expired") 3 else 2,calls)
            assertEquals(if(scenario=="expired") "e".repeat(64) else "c".repeat(64),db.validationDao().publication("s1")?.snapshot)
        }
    }
    @Test fun oldCredentialResponseCannotActivateItsPublication() = runTest { withDb { db ->
        val api=object: StationApi by unusedApi {
            override suspend fun codeHistory(id:String,cursor:String?,snapshot:String?,limit:Int):ValidationHistoryPage {
                db.recovery.reject(db.recovery.token())
                db.reconnectSameDeviceForTest()
                return page()
            }
        }
        assertTrue(runCatching { ValidationHistoryMirror(db,api,json).refresh("s1","p1") }.exceptionOrNull() is RecoveryBlocked)
        assertEquals("previous",db.validationDao().publication("s1")?.publication)
    } }
}
