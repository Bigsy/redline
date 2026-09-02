package com.hedworth.redline.diff

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffContext
import com.intellij.diff.contents.DiffContent
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.ide.highlighter.HtmlFileType
import com.intellij.ide.highlighter.XHtmlFileType
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.project.Project
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * [RedlineDiffTool.canShow] decides whether Redline appears in the diff viewer switcher at all —
 * too permissive and the pane offers a rendered view of markup it cannot render; too strict and
 * the plugin silently never shows up.
 *
 * The JCEF probe is stubbed: a headless test JVM has no JCEF, so without stubbing every case
 * would collapse into the same "unavailable → false" answer.
 */
class RedlineDiffToolTest : BasePlatformTestCase() {
    private val tool = RedlineDiffTool()

    override fun setUp() {
        super.setUp()
        RedlineDiffTool.jcefAvailable = { true }
    }

    override fun tearDown() {
        try {
            RedlineDiffTool.resetJcefProbe()
        } finally {
            super.tearDown()
        }
    }

    private fun html(text: String = "<p>hi</p>"): DiffContent =
        DiffContentFactory.getInstance().create(project, text, HtmlFileType.INSTANCE)

    private fun plainText(text: String = "hi"): DiffContent =
        DiffContentFactory.getInstance().create(project, text, PlainTextFileType.INSTANCE)

    private fun empty(): DiffContent = DiffContentFactory.getInstance().createEmpty()

    private fun canShow(vararg contents: DiffContent): Boolean {
        val request = when (contents.size) {
            2 -> SimpleDiffRequest("test", contents[0], contents[1], "before", "after")
            3 -> SimpleDiffRequest("test", contents[0], contents[1], contents[2], "base", "left", "right")
            else -> throw IllegalArgumentException("diff requests have 2 or 3 sides")
        }
        return tool.canShow(TestDiffContext(project), request)
    }

    fun testTwoHtmlSidesAreShown() {
        assertTrue(canShow(html("<p>old</p>"), html("<p>new</p>")))
    }

    fun testXhtmlSidesAreShown() {
        // XHTML's FileType name is "XHTML", so this side only matches through the extension
        // branch of isHtml — the other test cases all match on the name.
        val xhtml = DiffContentFactory.getInstance().create(project, "<p/>", XHtmlFileType.INSTANCE)
        assertEquals("xhtml", XHtmlFileType.INSTANCE.defaultExtension)
        assertTrue(canShow(xhtml, html()))
    }

    fun testHtmlAgainstAnEmptySideIsShown() {
        // Added/deleted file: the missing side is EmptyContent and the viewer renders one-sided.
        assertTrue(canShow(html(), empty()))
        assertTrue(canShow(empty(), html()))
    }

    fun testHtmlAgainstNonHtmlIsNotShown() {
        assertFalse(canShow(html(), plainText()))
        assertFalse(canShow(plainText(), html()))
    }

    fun testTwoEmptySidesAreNotShown() {
        assertFalse(canShow(empty(), empty()))
    }

    fun testThreeSidedRequestsAreNotShown() {
        // A merge request: the redline merges exactly two sides, so it must decline.
        assertFalse(canShow(html("<p>base</p>"), html("<p>left</p>"), html("<p>right</p>")))
    }

    fun testNothingIsShownWithoutJcef() {
        RedlineDiffTool.jcefAvailable = { false }
        assertFalse(canShow(html("<p>old</p>"), html("<p>new</p>")))
    }

    private class TestDiffContext(private val project: Project) : DiffContext() {
        override fun getProject(): Project = project

        override fun isWindowFocused(): Boolean = false

        override fun isFocusedInWindow(): Boolean = false

        override fun requestFocusInWindow() = Unit
    }
}
