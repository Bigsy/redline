package com.hedworth.redline.diff

import com.hedworth.redline.jcef.RedlineNavigationGuard
import com.hedworth.redline.web.RedlineWebResources
import com.intellij.diff.FrameDiffTool
import com.intellij.diff.contents.DocumentContent
import com.intellij.diff.requests.ContentDiffRequest
import com.intellij.icons.AllIcons
import com.intellij.ide.ActivityTracker
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.IdeActions
import com.intellij.openapi.actionSystem.Toggleable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.util.Computable
import com.intellij.openapi.util.Disposer
import com.intellij.ui.JBColor
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefBrowserBuilder
import com.intellij.ui.jcef.JBCefClient
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.Alarm
import com.intellij.util.SingleAlarm
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

    // The request's two sides. Kept because the documents are re-read on every live refresh: in
    // a Local Changes or editor diff the after side IS the live Document and changes as the user
    // types. VCS-revision sides are immutable, so re-reading them is a no-op.
    private var beforeContent: DocumentContent? = null
    private var afterContent: DocumentContent? = null

    // Latest text of each side, and the directories their relative assets resolve against.
    private var beforeHtml = ""
    private var afterHtml = ""
    private var beforeDir: Path? = null
    private var afterDir: Path? = null
    private var documentFormat: RedlineDocumentFormat = RedlineDocumentFormat.HTML
    private var dark = false

    /**
     * Redline-local side swap. Compare Files orders sides by project-tree position, which puts an
     * alphabetically-earlier "after" file on the left — the redline then reads inverted. The text
     * viewers own the request-level Swap Sides action; this one only re-renders the redline.
     */
    private var swapped = false

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
        beforeContent = before
        afterContent = after
        documentFormat = RedlineDiffTool.detectFormat(request) ?: RedlineDocumentFormat.HTML

        readSides()
        beforeDir = before?.let(::assetBaseDir)
        afterDir = after?.let(::assetBaseDir)
        dark = !JBColor.isBright()

        val id = openCurrentSession()
        sessionId = id

        try {
            val newBrowser = JBCefBrowserBuilder().build()
            Disposer.register(this, newBrowser)
            browser = newBrowser
            installNavigationBridge(newBrowser)
            newBrowser.jbCefClient.addRequestHandler(RedlineNavigationGuard(), newBrowser.cefBrowser)

            RedlineWebResources.registerSchemeHandler()
            newBrowser.loadURL(RedlineWebResources.viewerUrl(id, dark, documentFormat))

            panel.add(newBrowser.component, BorderLayout.CENTER)
            followIdeTheme(newBrowser)
            followDocumentEdits()
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
            SwapSidesAction(),
        )
        return components
    }

    /**
     * Snapshot both sides' text. Re-run on every live refresh and before a side swap; a missing
     * side (EmptyContent in an added/deleted-file diff) becomes the empty string, which the shell
     * recognizes as the one-sided state.
     *
     * Application.runReadAction, not the `runReadAction {}` Kotlin extension or
     * ReadAction.compute: both of those are deprecated from 2026.1, and the replacement the
     * platform points at there (ReadAction.computeBlocking) does not exist on the 2024.1
     * baseline. This overload is present in 2024.1 and undeprecated in 2026.2.
     */
    private fun readSides() {
        val app = ApplicationManager.getApplication()
        beforeHtml = beforeContent?.let { c -> app.runReadAction(Computable { c.document.text }) } ?: ""
        afterHtml = afterContent?.let { c -> app.runReadAction(Computable { c.document.text }) } ?: ""
    }

    /**
     * Which text plays which role for the current [swapped] state, and the directory
     * document-relative assets resolve against. The v1 assets cheat serves the CURRENT after
     * side's directory, falling back to the other side (VCS revisions and empty sides aren't
     * file-backed).
     */
    private class Sides(val before: String, val after: String, val baseDir: Path?)

    private fun currentSides(): Sides =
        if (swapped) {
            Sides(before = afterHtml, after = beforeHtml, baseDir = beforeDir ?: afterDir)
        } else {
            Sides(before = beforeHtml, after = afterHtml, baseDir = afterDir ?: beforeDir)
        }

    /** Opens the session the shell is first pointed at. Later changes go through [pushToShell]. */
    private fun openCurrentSession(): String {
        val sides = currentSides()
        return RedlineWebResources.openSession(
            beforeHtml = sides.before,
            afterHtml = sides.after,
            baseDir = sides.baseDir,
            format = documentFormat,
        )
    }

    /**
     * Live refresh. The platform's text viewers follow the live Document as the user types; the
     * redline has to as well, or a Local Changes diff quietly shows the file as it was when the
     * pane opened.
     *
     * Debounced through a [SingleAlarm] on the EDT: comparisons are bounded but substantial work, so a request per
     * keystroke would be a request per character too many. `ModalityState.any()` keeps it firing
     * while a modal (a commit dialog, say) is up, which is exactly when a diff is being read; the
     * runnable only reads documents and posts JS, so it touches no model under that modality.
     * Listeners and alarm are both scoped to this viewer's disposable, so they die with the pane.
     *
     * Every argument is passed explicitly, and yes, this overload is deprecated from 2024.3 on
     * ("please use flow instead") — do not "fix" it. Kotlin compiles any call that RELIES on
     * SingleAlarm's default arguments into the synthetic `DefaultConstructorMarker` constructor,
     * whose signature changed in 2024.3 (a `CoroutineScope` parameter was added), so
     * `SingleAlarm(task, delay, this)` is a `NoSuchMethodError` on every IDE from 2024.3 up — the
     * Plugin Verifier reports it as a compatibility problem, not merely a deprecation. This
     * five-argument form is a real constructor present and resolvable across 2024.1–2026.x; the
     * non-deprecated alternatives are either `@ApiStatus.Internal`, coroutine-scoped, or absent
     * on the 2024.1 baseline.
     */
    private fun followDocumentEdits() {
        @Suppress("DEPRECATION")
        val alarm = SingleAlarm(
            Runnable { refresh() },
            REFRESH_DEBOUNCE_MS,
            this,
            Alarm.ThreadToUse.SWING_THREAD,
            ModalityState.any(),
        )
        val listener = object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) = alarm.cancelAndRequest()
        }
        // Distinct documents only: a file compared against itself would otherwise queue two
        // requests per keystroke. Immutable VCS-revision documents simply never fire.
        listOfNotNull(beforeContent?.document, afterContent?.document)
            .distinct()
            .forEach { it.addDocumentListener(listener, this) }
    }

    private fun refresh() {
        val id = sessionId ?: return
        val previousBefore = beforeHtml
        val previousAfter = afterHtml
        readSides()
        // An edit can leave both sides' text identical (an undo/redo round-trip, a change the
        // platform normalizes away). Re-rendering then buys nothing and costs a scroll jitter.
        if (beforeHtml == previousBefore && afterHtml == previousAfter) return
        pushToShell(id)
    }

    /**
     * Replace the live session's content and ask the shell to re-render in place.
     *
     * Deliberately NOT `loadURL`: a reload would throw away the reader's scroll position and
     * re-run the bridge-injection race. [RedlineWebResources.updateSession] keeps the session id,
     * so the shell's fetch URLs and any in-flight asset request stay valid.
     */
    private fun pushToShell(id: String) {
        val sides = currentSides()
        val updated = RedlineWebResources.updateSession(
            id = id,
            beforeHtml = sides.before,
            afterHtml = sides.after,
            baseDir = sides.baseDir,
        )
        if (!updated) return
        val cef = browser?.cefBrowser ?: return
        cef.executeJavaScript("window.__redlineReload && window.__redlineReload();", cef.url, 0)
    }

    /**
     * The shell's theme rides in the viewer URL, which is only read at load time — a LaF switch
     * with a diff already open would otherwise leave light chrome on a dark IDE until the viewer
     * is reopened. The shell keys its chrome off `html[data-theme]` (see viewer.ts#applyTheme),
     * so re-stamping the attribute is the whole update. Markdown documents also use this theme
     * attribute for their document stylesheet.
     *
     * The connection is scoped to this viewer's disposable, so it unsubscribes with the pane.
     */
    private fun followIdeTheme(browser: JBCefBrowser) {
        ApplicationManager.getApplication().messageBus.connect(this).subscribe(
            LafManagerListener.TOPIC,
            LafManagerListener {
                val nowDark = !JBColor.isBright()
                if (nowDark == dark) return@LafManagerListener
                dark = nowDark
                val cef = browser.cefBrowser
                cef.executeJavaScript(applyThemeJs(), cef.url, 0)
            },
        )
    }

    /** Re-stamps the shell's theme attribute; `viewer.ts#applyTheme` writes the same one. */
    private fun applyThemeJs(): String =
        "document.documentElement.dataset.theme = '${if (dark) "dark" else "light"}';"

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
                        // The theme rides in the URL, which was fixed at loadURL time: a LaF switch
                        // between then and now would otherwise be lost (the page that received the
                        // listener's update no longer exists).
                        cefBrowser?.executeJavaScript(applyThemeJs(), cefBrowser.url, 0)
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
     * Swaps which side the redline treats as the original, Redline-locally: the live session's
     * sides are exchanged and the shell re-renders in place (the same path a live refresh takes).
     * Presented as a toggle so an active swap is visible in the toolbar.
     */
    private inner class SwapSidesAction :
        DumbAwareAction("Swap Sides", "Treat the other side as the original", AllIcons.Actions.SwapPanels) {

        override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

        override fun update(e: AnActionEvent) {
            e.presentation.isEnabled = browser != null
            Toggleable.setSelected(e.presentation, swapped)
        }

        override fun actionPerformed(e: AnActionEvent) {
            val id = sessionId ?: return
            swapped = !swapped
            // The shell re-reports "0,-1" as it tears down, but that round-trips through CEF and
            // the toolbar's next update() may beat it back.
            changeCount = 0
            readSides() // pick up an edit the refresh debounce hasn't fired for yet
            pushToShell(id)
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

    private companion object {
        /**
         * Quiet period after the last edit before the redline is recomputed. Long enough that
         * typing a word queues one refresh rather than one per character, short enough to read
         * as live.
         */
        const val REFRESH_DEBOUNCE_MS = 400
    }
}
