package com.hedworth.redline.diff

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffContext
import com.intellij.diff.contents.DiffContent
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.diff.util.DiffUserDataKeysEx
import com.intellij.ide.highlighter.HtmlFileType
import com.intellij.ide.highlighter.XHtmlFileType
import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.fileTypes.PlainTextFileType
import com.intellij.openapi.project.Project
import com.intellij.testFramework.LightVirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.vcsUtil.VcsUtil
import javax.swing.Icon

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

    private fun markdown(text: String = "# hi", fileName: String = "README.md"): DiffContent =
        plainText(text).also { it.putUserData(DiffUserDataKeysEx.FILE_NAME, fileName) }

    private fun markdownAtPath(text: String, path: String): DiffContent =
        DiffContentFactory.getInstance().create(project, text, VcsUtil.getFilePath(path, false))

    private fun markdownAtHighlightFile(text: String, path: String): DiffContent {
        val file = LightVirtualFile(path, PlainTextFileType.INSTANCE, text)
        return DiffContentFactory.getInstance().create(project, text, file)
    }

    private fun namedFileType(name: String, extension: String, binary: Boolean = false): FileType =
        object : FileType {
            override fun getName(): String = name
            override fun getDescription(): String = name
            override fun getDefaultExtension(): String = extension
            override fun getIcon(): Icon? = null
            override fun isBinary(): Boolean = binary
        }

    private fun typedMarkdown(text: String = "# hi"): DiffContent =
        DiffContentFactory.getInstance().create(project, text, namedFileType("Markdown", "md"))

    private fun empty(): DiffContent = DiffContentFactory.getInstance().createEmpty()

    private fun canShow(vararg contents: DiffContent): Boolean {
        return canShowRequest(newRequest(*contents))
    }

    private fun newRequest(vararg contents: DiffContent): SimpleDiffRequest = when (contents.size) {
            2 -> SimpleDiffRequest("test", contents[0], contents[1], "before", "after")
            3 -> SimpleDiffRequest("test", contents[0], contents[1], contents[2], "base", "left", "right")
            else -> throw IllegalArgumentException("diff requests have 2 or 3 sides")
        }

    private fun canShowRequest(request: SimpleDiffRequest): Boolean =
        tool.canShow(TestDiffContext(project), request)

    fun testTwoHtmlSidesAreShown() {
        assertTrue(canShow(html("<p>old</p>"), html("<p>new</p>")))
    }

    fun testXhtmlSidesAreShown() {
        // XHTML's FileType name and extension are both accepted as HTML.
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

    fun testMarkdownSidesAreShownForEverySupportedExtension() {
        for (extension in listOf("md", "markdown", "mdown", "mkd", "mkdn", "MD")) {
            assertTrue(".$extension should be rendered", canShow(markdown(fileName = "before.$extension"), markdown(fileName = "after.$extension")))
        }
    }

    fun testMarkdownFileTypeIsShownWithoutAFileName() {
        assertTrue(canShow(typedMarkdown("# old"), typedMarkdown("# new")))
    }

    fun testPlainTextRevisionUsesLiveHighlightFileName() {
        assertTrue(
            canShow(
                markdownAtHighlightFile("# old", "docs/README.md"),
                markdownAtHighlightFile("# new", "docs/README.md"),
            ),
        )
    }

    fun testRevisionTitlesCanSupplyMarkdownNameWhenContentHasNoFile() {
        val request = SimpleDiffRequest("test", plainText("# old"), plainText("# new"), "before.md", "after.md")
        assertTrue(canShowRequest(request))
    }

    fun testMarkdownAgainstAnEmptySideIsShown() {
        assertTrue(canShow(markdown(), empty()))
        assertTrue(canShow(empty(), markdown()))
    }

    fun testRevisionBackedMarkdownUsesPlatformFileNameMetadata() {
        // Revision content has no live file or highlight file, but DiffContentFactory preserves
        // the original path in FILE_NAME so a plain text document can still be recognized.
        val request = newRequest(plainText("# old"), plainText("# new"))
        request.putUserData(DiffUserDataKeysEx.FILE_NAME, "docs/README.md")
        assertTrue(canShowRequest(request))
    }

    fun testRevisionBackedMarkdownUsesFilePathMetadataWithoutALiveFile() {
        // The FilePath overload creates an in-memory document and records only the revision path;
        // there is no local VirtualFile to inspect in this case.
        assertTrue(canShow(markdownAtPath("# old", "docs/README.md"), markdownAtPath("# new", "docs/README.md")))
    }

    fun testMixedHtmlAndMarkdownIsNotShown() {
        assertFalse(canShow(html(), markdown()))
        assertFalse(canShow(markdown(), html()))
    }

    fun testUnsupportedDocumentIsNotShown() {
        assertFalse(canShow(plainText(), plainText()))
        assertFalse(canShow(markdown(fileName = "README.txt"), markdown(fileName = "README.txt")))
    }

    fun testBinaryMarkdownNamedContentIsNotShown() {
        val binaryType = namedFileType("Binary Markdown", "md", binary = true)
        val binary = DiffContentFactory.getInstance().createBinary(project, byteArrayOf(0), binaryType, "README.md")
        assertFalse(canShow(binary, markdown()))
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
