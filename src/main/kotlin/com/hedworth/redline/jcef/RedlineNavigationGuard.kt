package com.hedworth.redline.jcef

import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.handler.CefResourceRequestHandler
import org.cef.handler.CefResourceRequestHandlerAdapter
import org.cef.misc.BoolRef
import org.cef.network.CefRequest

/**
 * Confines the redline pane to Redline-served content at the network layer.
 *
 * The iframe sandbox kills the reviewed documents' scripts, but it does NOT stop self-navigation
 * (`<meta http-equiv="refresh">`, link clicks) or subresource loads — a reviewed document could
 * navigate the pane away or phone home via images/styles/fonts. The frontend strips refresh
 * directives and injects a CSP as the first line of defense; this handler is the backstop that
 * holds even for content those layers can't reach (e.g. the raw after side shown by the fallback
 * states): every navigation and resource request outside the Redline origin is cancelled.
 */
internal class RedlineNavigationGuard : CefRequestHandlerAdapter() {
    override fun onBeforeBrowse(
        browser: CefBrowser?,
        frame: CefFrame?,
        request: CefRequest?,
        userGesture: Boolean,
        isRedirect: Boolean,
    ): Boolean = !isAllowed(request?.url) // true cancels the navigation

    override fun getResourceRequestHandler(
        browser: CefBrowser?,
        frame: CefFrame?,
        request: CefRequest?,
        isNavigation: Boolean,
        isDownload: Boolean,
        requestInitiator: String?,
        disableDefaultHandling: BoolRef?,
    ): CefResourceRequestHandler = ResourceGuard

    private object ResourceGuard : CefResourceRequestHandlerAdapter() {
        override fun onBeforeResourceLoad(
            browser: CefBrowser?,
            frame: CefFrame?,
            request: CefRequest?,
        ): Boolean = !isAllowed(request?.url) // true cancels the request
    }

    private companion object {
        fun isAllowed(url: String?): Boolean {
            if (url == null) return false
            return url.startsWith("http://redline.localhost/") ||
                url.startsWith("about:") || // the shell's sandboxed frame starts as about:blank
                url.startsWith("data:") || // data: assets carry no network access
                url.startsWith("chrome-error://") || // CEF's own error page for cancelled loads
                url.startsWith("devtools://")
        }
    }
}
