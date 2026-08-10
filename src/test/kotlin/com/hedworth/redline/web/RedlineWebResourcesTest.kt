package com.hedworth.redline.web

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Session lifecycle: `sessions` must drain when viewers close them, or every diff opened leaks
 * both documents in memory for the IDE's lifetime. [RedlineWebResources.sessionCount] exists only
 * for this observation ([RedlineDiffViewer.dispose] calls [RedlineWebResources.closeSession];
 * end-to-end disposal is exercised in the runIde sandbox since it needs a live JCEF browser).
 */
class RedlineWebResourcesTest {
    @Test
    fun sessionsDrainWhenClosed() {
        val before = RedlineWebResources.sessionCount()

        val ids = List(3) { RedlineWebResources.openSession("<html>b</html>", "<html>a</html>", baseDir = null) }
        assertEquals(before + 3, RedlineWebResources.sessionCount())

        ids.forEach(RedlineWebResources::closeSession)
        assertEquals(before, RedlineWebResources.sessionCount())
    }

    @Test
    fun closingAnUnknownSessionIsANoOp() {
        val before = RedlineWebResources.sessionCount()
        RedlineWebResources.closeSession("no-such-session")
        assertEquals(before, RedlineWebResources.sessionCount())
    }
}
