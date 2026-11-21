package org.rhea.workspace

import org.junit.Assert.assertEquals
import org.junit.Test

class RheaDocumentsTest {
    @Test fun documentNameKeepsUnicodeAndRemovesSeparatorsAndControls() {
        assertEquals("Órbita_AM_agora.zip", cleanDocumentName("Órbita/AM\nagora.zip"))
        assertEquals("arquivo", cleanDocumentName(".."))
        assertEquals(150, cleanDocumentName("A".repeat(300)).length)
    }
    @Test fun sizeUsesBinaryUnitsAndPortugueseDecimalSeparator() {
        assertEquals("0 B", formatSize(0))
        assertEquals("1,5 MiB", formatSize(1572864))
    }
}
