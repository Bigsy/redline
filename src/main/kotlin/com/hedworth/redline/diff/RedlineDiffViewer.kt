package com.hedworth.redline.diff

import com.hedworth.redline.jcef.RedlineNavigationGuard
import com.hedworth.redline.web.RedlineWebResources
import com.intellij.diff.FrameDiffTool
import com.intellij.diff.contents.DocumentContent
import com.intellij.diff.requests.ContentDiffRequest
import com.intellij.icons.AllIcons
import com.intellij.ide.ActivityTracker
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.IdeActions
import com.intellij.openapi.application.runReadAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.util.Disposer
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefBrowserBuilder
import com.intellij.ui.jcef.JBCefClient
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import java.awt.BorderLayout
import java.nio.file.Path
import javax.swing.Icon
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * The rendered-diff viewer: one JCEF pane showing the viewer shell, which renders the redline
 * document inside a sandboxed iframe (`sandbox="allow-same-origin"`, no `allow-scripts`) — the
 * reviewed documents' scripts are structurally unable to execute, and nothing reviewed is ever
 * loaded as the top-level page (see PLAN.md decision #6).
 *
 * One-sided requests (file added/deleted) are supported: the missing side is an `EmptyContent`
 * and its HTML is the empty string; the shell renders the side that exists with an info banner.
 */
class RedlineDiffViewer(private val request: ContentDiffRequest) : FrameDiffTool.DiffViewer, Disposable {
    private val panel = JPanel(BorderLayout())
    private var browser: JBCefBrowser? = null
    private var sessionId: String? = null

    /**
     * Change-block count last reported by the shell over the JS bridge (`"<count>,<current>"`).
     * Written on a CEF thread, read by the toolbar actions' `update()` — hence volatile.
     */
    @Volatile
    private var changeCount = 0

    override fun getComponent(): JComponent = panel

    override fun getPreferredFocusedComponent(): JComponent? = browser?.component

    override fun init(): FrameDiffTool.ToolbarComponents {
        val contents = request.contents
        val before = contents[0] as? DocumentContent
        val after = contents[1] as? DocumentContent

        // A missing side (EmptyContent in an added/deleted-file diff) becomes the empty string;
        // the shell recognizes it and renders the one-sided state.
        val beforeHtml = before?.let { runReadAction { it.document.text } } ?: ""
        val afterHtml = after?.let { runReadAction { it.document.text } } ?: ""

        val id = RedlineWebResources.openSession(
            beforeHtml = beforeHtml,
            afterHtml = afterHtml,
            baseDir = (after ?: before)?.let(::assetBaseDir),
        )
        sessionId = id

        try {
            val newBrowser = JBCefBrowserBuilder().build()
            Disposer.register(this, newBrowser)
            browser = newBrowser
            installNavigationBridge(newBrowser)
            newBrowser.jbCefClient.addRequestHandler(RedlineNavigationGuard(), newBrowser.cefBrowser)

            RedlineWebResources.registerSchemeHandler()
            newBrowser.loadURL(RedlineWebResources.viewerUrl(id, dark = !JBColor.isBright()))

            panel.add(newBrowser.component, BorderLayout.CENTER)
        } catch (t: Throwable) {
            // A JCEF failure after openSession must not leak the session (dispose() may never
            // run if init() throws before the viewer is registered anywhere).
            RedlineWebResources.closeSession(id)
            sessionId = null
            throw t
        }

        val components = FrameDiffTool.ToolbarComponents()
        components.toolbarActions = listOf(
            NavigateChangeAction(
                direction = "prev",
                text = "Previous Change",
                icon = AllIcons.Actions.PreviousOccurence,
                shortcutActionId = IdeActions.ACTION_PREVIOUS_DIFF,
            ),
            NavigateChangeAction(
                direction = "next",
                text = "Next Change",
                icon = AllIcons.Actions.NextOccurence,
                shortcutActionId = IdeActions.ACTION_NEXT_DIFF,
            ),
        )
        return components
    }

    /**
     * JS→Kotlin half of the toolbar wiring: the shell reports `"<blockCount>,<currentIndex>"`
     * whenever navigation state changes, which drives the actions' enablement.
     *
     * The injection snippet for a [JBCefJSQuery] is generated per query, so the shell can't hard-
     * code the call; instead `window.__redlineReport` is defined from here once the page loads,
     * and `window.__redlineFlush()` (shell-defined) re-sends whatever state was reported while
     * the bridge didn't exist yet.
     */
    private fun installNavigationBridge(browser: JBCefBrowser) {
        // The query is created before the native browser exists (pre-loadURL). The pool property
        // is set anyway as a belt: it keeps late query creation legal if init order ever changes.
        browser.jbCefClient.setProperty(JBCefClient.Properties.JS_QUERY_POOL_SIZE, 1)
        val query = JBCefJSQuery.create(browser as JBCefBrowserBase)
        Disposer.register(browser, query)
        query.addHandler { state ->
            changeCount = state.substringBefore(',').toIntOrNull() ?: 0
            // Toolbars re-run update() on user activity; a report from the page isn't one.
            ActivityTracker.getInstance().inc()
            null
        }

        val reportJs =
            "window.__redlineReport = function(state) { ${query.inject("state")} };" +
                "if (window.__redlineFlush) window.__redlineFlush();"
        browser.jbCefClient.addLoadHandler(
            object : CefLoadHandlerAdapter() {
                override fun onLoadEnd(cefBrowser: CefBrowser?, frame: CefFrame?, httpStatusCode: Int) {
                    if (frame?.isMain == true) {
                        cefBrowser?.executeJavaScript(reportJs, cefBrowser.url, 0)
                    }
                }
            },
            browser.cefBrowser,
        )
    }

    /**
     * Kotlin→JS half: F7-style next/previous actions in the diff toolbar, forwarded to the
     * shell's `window.__redlineNav`. Disabled until the shell reports at least one change block
     * (states without markers report zero).
     */
    private inner class NavigateChangeAction(
        private val direction: String,
        text: String,
        icon: Icon,
        shortcutActionId: String,
    ) : DumbAwareAction(text, null, icon) {
        init {
            // Reuse the platform's next/previous-difference shortcuts (F7 / Shift+F7). They only
            // fire while Swing focus is outside the native browser; in-page `n`/`p` cover the rest.
            ActionManager.getInstance().getAction(shortcutActionId)?.let(::copyShortcutFrom)
            registerCustomShortcutSet(panel, this@RedlineDiffViewer)
        }

        override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

        override fun update(e: AnActionEvent) {
            e.presentation.isEnabled = changeCount > 0
        }

        override fun actionPerformed(e: AnActionEvent) {
            val cef = browser?.cefBrowser ?: return
            cef.executeJavaScript("window.__redlineNav && window.__redlineNav('$direction');", cef.url, 0)
        }
    }

    /**
     * Directory that document-relative asset URLs (`assets/doc.css`, images) resolve against.
     *
     * v1 "assets cheat": both sides get the after side's on-disk assets (the before side's for a
     * deleted file). The after side of a local diff is the working-tree file; VCS-revision
     * contents aren't file-backed, in which case assets simply 404 and the document renders
     * unstyled (acceptable for the skeleton).
     */
    private fun assetBaseDir(content: DocumentContent): Path? {
        val file = FileDocumentManager.getInstance().getFile(content.document) ?: return null
        val parent = file.parent ?: return null
        return runCatching { parent.toNioPath() }.getOrNull()
    }

    override fun dispose() {
        sessionId?.let(RedlineWebResources::closeSession)
        sessionId = null
        // The browser is registered with Disposer against this viewer.
    }
}
