package com.hedworth.redline.diff

import com.hedworth.redline.jcef.JcefSupport
import com.intellij.diff.DiffContext
import com.intellij.diff.FrameDiffTool
import com.intellij.diff.contents.DiffContent
import com.intellij.diff.contents.DocumentContent
import com.intellij.diff.contents.EmptyContent
import com.intellij.diff.requests.ContentDiffRequest
import com.intellij.diff.requests.DiffRequest

/**
 * Offers a rendered redline view whenever both sides of a diff are HTML documents — or one side
 * is HTML and the other is empty (an added/deleted file), which renders one-sided.
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
        if (!JcefSupport.isAvailable()) return false
        val contents = (request as? ContentDiffRequest)?.contents ?: return false
        if (contents.size != 2) return false
        val htmlSides = contents.count { it is DocumentContent && isHtml(it) }
        val emptySides = contents.count { it is EmptyContent }
        return htmlSides == 2 || (htmlSides == 1 && emptySides == 1)
    }

    override fun createComponent(context: DiffContext, request: DiffRequest): FrameDiffTool.DiffViewer =
        RedlineDiffViewer(request as ContentDiffRequest)

    private fun isHtml(content: DiffContent): Boolean {
        val type = content.contentType ?: return false
        return type.name.equals("HTML", ignoreCase = true) ||
            type.defaultExtension.lowercase() in HTML_EXTENSIONS
    }

    private companion object {
        val HTML_EXTENSIONS = setOf("html", "htm", "xhtml")
    }
}
