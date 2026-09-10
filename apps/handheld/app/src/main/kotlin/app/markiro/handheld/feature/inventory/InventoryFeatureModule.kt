package app.markiro.handheld.feature.inventory

import app.markiro.handheld.core.inventory.InventoryBundleMirror
import app.markiro.handheld.core.network.StationApi
import app.markiro.handheld.core.storage.HandheldDatabase
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object InventoryFeatureModule {
    @Provides
    @Singleton
    fun inventoryGateway(api: StationApi, db: HandheldDatabase, mirror: InventoryBundleMirror, json: Json): InventoryGateway =
        InventoryRepository(api, db, mirror, json)
}
