package app.markiro.handheld.core.storage

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(entities = [DeviceConfigEntity::class, OperatorEntity::class], version = 1, exportSchema = false)
abstract class HandheldDatabase : RoomDatabase() {
    abstract fun deviceConfigDao(): DeviceConfigDao
    abstract fun operatorDao(): OperatorDao
}
