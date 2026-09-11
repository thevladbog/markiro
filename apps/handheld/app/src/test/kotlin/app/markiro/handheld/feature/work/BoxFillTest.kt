package app.markiro.handheld.feature.work

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BoxFillTest {
    @Test
    fun theDrawnCapacityIsAGrid() {
        assertTrue(showsGrid(20))
        assertEquals(5, gridColumns(20))
        assertEquals(4, gridRows(20))
    }

    @Test
    fun aBoxOfHundredsBecomesACounter() {
        // Sixty is six rows of ten, the most that still reads as countable at the
        // mockup's cell size on a 360 dp screen.
        assertTrue(showsGrid(GRID_MAX_CAPACITY))
        assertFalse(showsGrid(GRID_MAX_CAPACITY + 1))
        assertFalse(showsGrid(120))
    }

    @Test
    fun theGridNeverGrowsWiderThanTenCells() {
        for (capacity in 1..GRID_MAX_CAPACITY) {
            assertTrue("capacity $capacity", gridColumns(capacity) <= 10)
            // Every unit has a cell: a grid that cannot show the whole box is worse
            // than a number.
            assertTrue("capacity $capacity", gridColumns(capacity) * gridRows(capacity) >= capacity)
        }
    }

    @Test
    fun aShiftWithoutACapacityDoesNotDrawAGrid() {
        assertFalse(showsGrid(0))
        assertFalse(showsGrid(-1))
    }
}
