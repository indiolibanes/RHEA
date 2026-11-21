package org.rhea.workspace

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RheaPresentationTest {
    @Test
    fun narrowAndLargeFontWindowsStayCompact() {
        assertFalse(useNavigationRail(719f, 1f))
        assertTrue(useNavigationRail(720f, 1f))
        assertFalse(useNavigationRail(980f, 1.8f))
    }

    @Test
    fun glassRequiresExplicitAuthorialOptInAndAnAccessibleSurface() {
        assertTrue(isPrismEnabled(true, true, 1f, false))
        assertFalse(isPrismEnabled(false, true, 1f, false))
        assertFalse(isPrismEnabled(true, false, 1f, false))
        assertFalse(isPrismEnabled(true, true, 1.5f, false))
        assertFalse(isPrismEnabled(true, true, 1f, true))
    }
}
