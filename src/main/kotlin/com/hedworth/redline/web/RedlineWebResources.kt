package com.hedworth.redline.web

import com.hedworth.redline.diff.RedlineDocumentFormat
import com.intellij.ui.jcef.JBCefApp
import org.cef.CefApp
import org.jetbrains.annotations.TestOnly
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.callback.CefCallback
import org.cef.callback.CefSchemeHandlerFactory
import org.cef.handler.CefResourceHandler
import org.cef.handler.CefResourceHandlerAdapter
import org.cef.misc.IntRef
import org.cef.misc.StringRef
import org.cef.network.CefRequest
import org.cef.network.CefResponse
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Serves everything the redline browser pane requests, all under `http://redline.localhost/`:
 *
 * - `/doc/<session>/before.html` and `/doc/<session>/after.html` — the two sides of the diff,
 *   held in memory per viewer session (VCS revisions have no file on disk).
 * - `/doc/<session>/<relative-path>` — document-relative assets (CSS, images), resolved against
 *   the session's base directory on disk (the after side's folder — the v1 assets cheat). The
 *   `/doc/<session>/` prefix means the documents' own relative URLs resolve here naturally.
 * - anything else — bundled viewer assets from the plugin's classpath (`resources/web/`).
 */
object RedlineWebResources {
    private const val HOST = "redline.localhost"
    private const val DOC_PREFIX = "doc"

    /**
     * CSP served with reviewed session documents: same-origin and data: assets only, so a
     * reviewed document cannot phone home via images/stylesheets/fonts. The sandbox blocks
     * scripts but NOT subresource loads. KEEP IN SYNC with `DOC_CSP` in frontend/src/diff.ts,
     * which injects the same policy into the merged redline (written documents get no headers).
     */
    private const val DOC_CSP =
        "default-src 'self' data:; style-src 'self' 'unsafe-inline' data:; " +
            "script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'"

    private val registered = AtomicBoolean(false)
    private val sessions = ConcurrentHashMap<String, Session>()

    private class Session(
        val beforeHtml: String,
        val afterHtml: String,
        val baseDir: Path?,
        val format: RedlineDocumentFormat,
    )

    fun openSession(
        beforeHtml: String,
        afterHtml: String,
        baseDir: Path?,
        format: RedlineDocumentFormat = RedlineDocumentFormat.HTML,
    ): String {
        val id = UUID.randomUUID().toString()
        sessions[id] = Session(beforeHtml, afterHtml, baseDir, format)
        return id
    }

    /**
     * Replace a live session's content in place, keeping the id — so the viewer URL, the shell's
     * `before.html`/`after.html` fetches and any in-flight asset request all stay valid. This is
     * how a live refresh (the reviewed document was edited in the IDE) and Swap Sides reach the
     * shell: no reload, so the reader keeps their scroll position and the JS bridge stays put.
     *
     * Returns false when the id is unknown — the viewer was disposed and its session closed, so
     * there is no shell left to tell about it.
     */
    fun updateSession(
        id: String,
        beforeHtml: String,
        afterHtml: String,
        baseDir: Path?,
        format: RedlineDocumentFormat? = null,
    ): Boolean = sessions.computeIfPresent(id) { _, current ->
        Session(beforeHtml, afterHtml, baseDir, format ?: current.format)
    } != null

    fun closeSession(id: String) {
        sessions.remove(id)
    }

    /** Sessions currently held. Only for tests verifying that viewer disposal drains them. */
    @TestOnly
    fun sessionCount(): Int = sessions.size

    /**
     * Resolve a URL exactly as the scheme handler would, without JCEF. Only for tests covering
     * routing, the asset-traversal guard, and MIME types headlessly.
     */
    @TestOnly
    internal fun responseFor(url: String): ResourceResponse = ResourceResponse.from(url)

    // Only the viewer shell is ever loaded top-level; reviewed documents are reachable solely via
    // /doc/<session>/… routes, which the shell loads into a sandboxed iframe (see PLAN.md #6).
    // The theme parameter styles the SHELL chrome and is also consumed by the Markdown document
    // stylesheet when the shell writes a converted document into its sandboxed frame.
    fun viewerUrl(
        id: String,
        dark: Boolean = false,
        format: RedlineDocumentFormat = RedlineDocumentFormat.HTML,
    ): String {
        val formatQuery = if (format == RedlineDocumentFormat.MARKDOWN) "&format=${format.queryValue}" else ""
        return "http://$HOST/index.html?session=$id&theme=${if (dark) "dark" else "light"}$formatQuery"
    }

    fun registerSchemeHandler() {
        if (!registered.compareAndSet(false, true)) {
            return
        }

        try {
            JBCefApp.getInstance()
            CefApp.getInstance().registerSchemeHandlerFactory("http", HOST, RedlineResourceHandlerFactory)
        } catch (t: Throwable) {
            // A failed JCEF init must not leave the flag stuck true — that would make every later
            // viewer skip registration and load against a dead scheme forever.
            registered.set(false)
            throw t
        }
    }

    private object RedlineResourceHandlerFactory : CefSchemeHandlerFactory {
        override fun create(
            browser: CefBrowser?,
            frame: CefFrame?,
            schemeName: String?,
            request: CefRequest?,
        ): CefResourceHandler = RedlineResourceHandler(request?.url)
    }

    /**
     * We extend [CefResourceHandlerAdapter] rather than implement [CefResourceHandler] directly: at
     * runtime JCEF (through 2026.x) drives the legacy processRequest/readResponse path, which we
     * override here. JCEF 2026.2+ also added abstract open/read/skip methods to the interface; the
     * adapter provides those, so a single build compiled against 2024.1 keeps working — and passes
     * the Plugin Verifier — across the whole supported range without referencing the newer API types.
     */
    private class RedlineResourceHandler(url: String?) : CefResourceHandlerAdapter() {
        private val response: ResourceResponse = ResourceResponse.from(url)
        private var offset = 0

        override fun processRequest(request: CefRequest?, callback: CefCallback?): Boolean {
            callback?.Continue()
            return true
        }

        override fun getResponseHeaders(
            response: CefResponse?,
            responseLength: IntRef?,
            redirectUrl: StringRef?,
        ) {
            response?.status = this.response.status
            response?.statusText = this.response.statusText
            response?.mimeType = this.response.mimeType
            response?.setHeaderByName("Cache-Control", "no-store", true)
            for ((name, value) in this.response.headers) {
                response?.setHeaderByName(name, value, true)
            }
            responseLength?.set(this.response.bytes.size)
        }

        override fun readResponse(
            dataOut: ByteArray?,
            bytesToRead: Int,
            bytesRead: IntRef?,
            callback: CefCallback?,
        ): Boolean {
            if (dataOut == null || offset >= response.bytes.size) {
                bytesRead?.set(0)
                return false
            }

            val count = minOf(bytesToRead, response.bytes.size - offset)
            response.bytes.copyInto(dataOut, destinationOffset = 0, startIndex = offset, endIndex = offset + count)
            offset += count
            bytesRead?.set(count)
            return true
        }

        override fun cancel() {
            offset = response.bytes.size
        }
    }

    internal data class ResourceResponse(
        val status: Int,
        val statusText: String,
        val mimeType: String,
        val bytes: ByteArray,
        val headers: Map<String, String> = emptyMap(),
    ) {
        companion object {
            fun from(url: String?): ResourceResponse {
                val path = requestPath(url)
                val segments = path.split('/').filter { it.isNotEmpty() }

                if (segments.size >= 3 && segments[0] == DOC_PREFIX) {
                    return sessionResponse(sessionId = segments[1], relativePath = segments.drop(2))
                }

                return classpathResponse(path)
            }

            private fun sessionResponse(sessionId: String, relativePath: List<String>): ResourceResponse {
                val session = sessions[sessionId]
                    ?: return notFound("Redline session not found: $sessionId")

                // The sides were decoded by the IDE and re-encoded UTF-8 here, so the charset must
                // be declared on the wire — an in-document <meta charset> claiming anything else
                // would garble non-ASCII text. JCEF's CefResponse has no setCharset; CEF passes the
                // mimeType string into the Content-Type header verbatim, so append it there.
                val relative = relativePath.joinToString("/")
                val docHeaders = mapOf("Content-Security-Policy" to DOC_CSP)
                when (relative) {
                    // Markdown is fetched as text for conversion in the shell. Keeping its MIME
                    // type non-HTML also prevents an accidental browser navigation from treating
                    // raw Markdown as a reviewed document before sanitization.
                    "after.html" -> return ok(documentMime(session.format), session.afterHtml.toByteArray(), docHeaders)
                    "before.html" -> return ok(documentMime(session.format), session.beforeHtml.toByteArray(), docHeaders)
                }

                val baseDir = session.baseDir
                    ?: return notFound("Redline session has no asset directory (VCS-revision content): $relative")

                // toRealPath() resolves symlinks before the containment check — a lexical
                // normalize()+startsWith guard is fooled by a symlink under the doc directory that
                // points outside it. It also throws for nonexistent files, which folds the
                // missing-asset case into the same notFound path.
                val base = runCatching { baseDir.toRealPath() }.getOrNull()
                    ?: return notFound("Redline asset directory not resolvable: $baseDir")
                val resolved = runCatching { base.resolve(relative).toRealPath() }.getOrNull()
                    ?: return notFound("Redline asset not found: $relative")
                if (!resolved.startsWith(base)) {
                    return notFound("Redline asset outside the document directory: $relative")
                }
                if (!Files.isRegularFile(resolved)) {
                    return notFound("Redline asset not found: $resolved")
                }

                return ok(mimeType(relative), Files.readAllBytes(resolved))
            }

            private fun classpathResponse(path: String): ResourceResponse {
                val resourcePath = "web/${path.removePrefix("/")}"
                val bytes = RedlineWebResources::class.java.classLoader
                    .getResourceAsStream(resourcePath)
                    ?.use { it.readBytes() }
                    ?: return notFound("Redline resource not found: $resourcePath")

                return ok(mimeType(resourcePath), bytes)
            }

            private fun requestPath(url: String?): String =
                url
                    ?.let { runCatching { URI(it).path }.getOrNull() }
                    ?.takeIf { it.isNotBlank() && it != "/" }
                    ?: "/index.html"

            private fun ok(mimeType: String, bytes: ByteArray, headers: Map<String, String> = emptyMap()) =
                ResourceResponse(status = 200, statusText = "OK", mimeType = mimeType, bytes = bytes, headers = headers)

            private fun documentMime(format: RedlineDocumentFormat): String = when (format) {
                RedlineDocumentFormat.HTML -> "text/html; charset=utf-8"
                RedlineDocumentFormat.MARKDOWN -> "text/plain; charset=utf-8"
            }

            private fun notFound(message: String) =
                ResourceResponse(status = 404, statusText = "Not Found", mimeType = "text/plain", bytes = message.toByteArray())

            private fun mimeType(path: String): String =
                when (path.substringAfterLast('.', missingDelimiterValue = "").lowercase()) {
                    "html", "htm", "xhtml" -> "text/html"
                    "js", "mjs" -> "application/javascript"
                    "css" -> "text/css"
                    "svg" -> "image/svg+xml"
                    "png" -> "image/png"
                    "jpg", "jpeg" -> "image/jpeg"
                    "gif" -> "image/gif"
                    "webp" -> "image/webp"
                    "avif" -> "image/avif"
                    "bmp" -> "image/bmp"
                    "ico" -> "image/x-icon"
                    "woff" -> "font/woff"
                    "woff2" -> "font/woff2"
                    "ttf" -> "font/ttf"
                    "otf" -> "font/otf"
                    "json", "map" -> "application/json"
                    "xml" -> "application/xml"
                    "txt" -> "text/plain"
                    "wasm" -> "application/wasm"
                    else -> "application/octet-stream"
                }
        }
    }
}
