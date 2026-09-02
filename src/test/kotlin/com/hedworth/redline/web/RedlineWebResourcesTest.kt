package com.hedworth.redline.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Session lifecycle: `sessions` must drain when viewers close them, or every diff opened leaks
 * both documents in memory for the IDE's lifetime. [RedlineWebResources.sessionCount] exists only
 * for this observation ([RedlineDiffViewer.dispose] calls [RedlineWebResources.closeSession];
 * end-to-end disposal is exercised in the runIde sandbox since it needs a live JCEF browser).
 *
 * Also covers [RedlineWebResources.updateSession], which live refresh and Swap Sides rely on to
 * change what a session serves WITHOUT changing its id — the whole point being that the shell's
 * URLs stay valid so it can re-render in place instead of reloading.
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

    @Test
    fun updateSessionReplacesWhatTheSameIdServes() {
        val id = RedlineWebResources.openSession("<p>v1 before</p>", "<p>v1 after</p>", baseDir = null)
        try {
            assertTrue(
                RedlineWebResources.updateSession(id, "<p>v2 before</p>", "<p>v2 after</p>", baseDir = null),
            )

            // The id is unchanged, so the shell's existing fetch URLs now return the new text.
            assertEquals("<p>v2 before</p>", String(get(id, "before.html").bytes))
            assertEquals("<p>v2 after</p>", String(get(id, "after.html").bytes))
            assertEquals(200, get(id, "after.html").status)
        } finally {
            RedlineWebResources.closeSession(id)
        }
    }

    @Test
    fun updateSessionSwapsWhichSideIsWhich() {
        // Swap Sides pushes the same two texts back with the roles exchanged.
        val id = RedlineWebResources.openSession("<p>left</p>", "<p>right</p>", baseDir = null)
        try {
            RedlineWebResources.updateSession(id, "<p>right</p>", "<p>left</p>", baseDir = null)
            assertEquals("<p>right</p>", String(get(id, "before.html").bytes))
            assertEquals("<p>left</p>", String(get(id, "after.html").bytes))
        } finally {
            RedlineWebResources.closeSession(id)
        }
    }

    @Test
    fun updatingAnUnknownSessionIsANoOpAndSaysSo() {
        val before = RedlineWebResources.sessionCount()
        // A disposed viewer's session is gone; the caller uses the false to skip telling a shell
        // that no longer exists to reload.
        assertFalse(RedlineWebResources.updateSession("no-such-session", "<p>b</p>", "<p>a</p>", baseDir = null))
        assertEquals(before, RedlineWebResources.sessionCount())
    }

    private fun get(id: String, relative: String) =
        RedlineWebResources.responseFor("http://redline.localhost/doc/$id/$relative")
}
