package com.hedworth.redline.diff

import com.hedworth.redline.jcef.JcefSupport
import com.intellij.diff.DiffContext
import com.intellij.diff.FrameDiffTool
import com.intellij.diff.contents.DiffContent
import com.intellij.diff.contents.DocumentContent
import com.intellij.diff.contents.EmptyContent
import com.intellij.diff.requests.ContentDiffRequest
import com.intellij.diff.requests.DiffRequest
import com.intellij.diff.util.DiffUserDataKeysEx
import org.jetbrains.annotations.TestOnly

/**
 * Offers a rendered redline view whenever both sides of a diff are documents in the same supported
 * format — HTML or Markdown — or one side is empty (an added/deleted file), which renders one-sided.
 *
 * Appears in the diff editor's viewer switcher alongside Side-by-side / Unified, the same way the
 * built-in image diff does. The platform resolves both sides' content (local changes, commits,
 * VCS revisions) before we ever see the request — no VCS plumbing here.
 *
 * JCEF types must not leak into this class's signatures: when the JCEF plugin is absent (optional
 * dependency), [canShow] returns false and [RedlineDiffViewer] is never classloaded.
 */
class RedlineDiffTool : FrameDiffTool {
    override fun getName(): String = "Redline"

    override fun canShow(context: DiffContext, request: DiffRequest): Boolean {
        if (!jcefAvailable()) return false
        val contents = (request as? ContentDiffRequest)?.contents ?: return false
        if (contents.size != 2) return false
        return detectFormat(request) != null
    }

    override fun createComponent(context: DiffContext, request: DiffRequest): FrameDiffTool.DiffViewer =
        RedlineDiffViewer(request as ContentDiffRequest)

    internal companion object {
        private val HTML_EXTENSIONS = setOf("html", "htm", "xhtml")
        private val MARKDOWN_EXTENSIONS = setOf("md", "markdown", "mdown", "mkd", "mkdn")

        /**
         * Resolve the format from the content itself and from the names the diff platform carries
         * for revision-backed content. VCS revisions often have no live VirtualFile, but
         * DiffContentFactory stores the original name in [DiffUserDataKeysEx.FILE_NAME].
         */
        internal fun formatOf(content: DiffContent, fallbackName: String? = null): RedlineDocumentFormat? {
            if (content is EmptyContent) return null
            // A named binary FileContent must not make Redline appear just because its extension
            // happens to be one we know. Rendered comparisons require editable document content.
            if (content !is DocumentContent) return null

            val type = content.contentType
            val typeName = type?.name.orEmpty()
            val typeExtension = type?.defaultExtension.orEmpty()
            val fromType = classify(typeName, typeExtension)
            if (fromType != null) return fromType

            val highlightFileName = content.highlightFile?.name
            val contentFileName = content.getUserData(DiffUserDataKeysEx.FILE_NAME)
            return sequenceOf(contentFileName, highlightFileName, fallbackName)
                .mapNotNull(::classify)
                .firstOrNull()
        }

        /**
         * Return a format only when the two non-empty sides agree. A single empty side inherits
         * the format of the existing side, which covers added and deleted files.
         */
        internal fun detectFormat(request: ContentDiffRequest): RedlineDocumentFormat? {
            val contents = request.contents
            if (contents.size != 2) return null
            val titles = request.contentTitles
            val requestName = request.getUserData(DiffUserDataKeysEx.FILE_NAME)
            val formats = contents.mapIndexed { index, content ->
                val title = titles.getOrNull(index)
                formatOf(content, requestName ?: title)
            }
            val nonEmpty = contents.withIndex().filter { it.value !is EmptyContent }
            if (nonEmpty.isEmpty()) return null
            if (nonEmpty.any { formats[it.index] == null }) return null
            val first = formats[nonEmpty.first().index] ?: return null
            return if (nonEmpty.all { formats[it.index] == first }) first else null
        }

        private fun classify(name: String?, extension: String? = null): RedlineDocumentFormat? {
            val value = name?.trim()?.lowercase()?.removePrefix(".") ?: return null
            val basename = value.substringAfterLast('/').substringAfterLast('\\')
            val nameExtension = basename.substringAfterLast('.', missingDelimiterValue = "")
            val direct = if (basename in HTML_EXTENSIONS || basename in MARKDOWN_EXTENSIONS) basename else nameExtension
            if (direct in HTML_EXTENSIONS || direct in MARKDOWN_EXTENSIONS) {
                return if (direct in HTML_EXTENSIONS) RedlineDocumentFormat.HTML else RedlineDocumentFormat.MARKDOWN
            }
            val suffix = extension?.trim()?.lowercase()?.removePrefix(".")
            return when (suffix) {
                in HTML_EXTENSIONS -> RedlineDocumentFormat.HTML
                in MARKDOWN_EXTENSIONS -> RedlineDocumentFormat.MARKDOWN
                else -> {
                    // FileType names are not guaranteed to be extensions (e.g. "Markdown").
                    when (basename) {
                        "html", "xhtml" -> RedlineDocumentFormat.HTML
                        "markdown", "commonmark" -> RedlineDocumentFormat.MARKDOWN
                        else -> null
                    }
                }
            }
        }

        private val DEFAULT_JCEF_PROBE: () -> Boolean = JcefSupport::isAvailable

        /**
         * The JCEF availability probe, indirected so [canShow] can be tested headlessly: a test
         * JVM has no JCEF, so every case would otherwise collapse into "JCEF unavailable → false".
         * Production code never assigns this.
         */
        @set:TestOnly
        var jcefAvailable: () -> Boolean = DEFAULT_JCEF_PROBE

        @TestOnly
        fun resetJcefProbe() {
            jcefAvailable = DEFAULT_JCEF_PROBE
        }
    }
}
