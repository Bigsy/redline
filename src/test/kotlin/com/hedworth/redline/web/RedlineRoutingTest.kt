package com.hedworth.redline.web

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * Headless coverage of the scheme handler's routing, the asset-traversal guard, and MIME types —
 * [RedlineWebResources.responseFor] resolves URLs exactly as the JCEF handler would, minus JCEF.
 *
 * The traversal cases matter: the session asset routes serve real files from the reviewed
 * document's directory, so `..`, percent-encoded dots, and symlinks pointing outside that
 * directory must all die as 404s (see the `toRealPath()` containment check).
 */
class RedlineRoutingTest {
    private lateinit var root: Path
    private lateinit var baseDir: Path
    private lateinit var secret: Path
    private val sessions = mutableListOf<String>()

    @Before
    fun setUp() {
        root = Files.createTempDirectory("redline-routing")
        baseDir = Files.createDirectories(root.resolve("docs"))
        secret = Files.write(root.resolve("secret.txt"), "TOP SECRET".toByteArray())
    }

    @After
    fun tearDown() {
        sessions.forEach(RedlineWebResources::closeSession)
        root.toFile().deleteRecursively()
    }

    private fun openSession(baseDir: Path? = this.baseDir): String =
        RedlineWebResources.openSession("<p>before</p>", "<p>after</p>", baseDir).also(sessions::add)

    private fun get(path: String) = RedlineWebResources.responseFor("http://redline.localhost$path")

    @Test
    fun sessionDocumentsAreRoutedWithCharsetAndCsp() {
        val id = openSession()

        val after = get("/doc/$id/after.html")
        assertEquals(200, after.status)
        // The charset must ride in the mimeType string — CEF passes it into Content-Type verbatim.
        assertEquals("text/html; charset=utf-8", after.mimeType)
        assertEquals("<p>after</p>", String(after.bytes))
        val csp = after.headers["Content-Security-Policy"]
        assertTrue("session docs must carry the CSP header", csp != null && csp.contains("script-src 'none'"))

        val before = get("/doc/$id/before.html")
        assertEquals(200, before.status)
        assertEquals("<p>before</p>", String(before.bytes))
    }

    @Test
    fun unknownAndClosedSessionsAre404() {
        assertEquals(404, get("/doc/no-such-session/after.html").status)

        val id = openSession()
        RedlineWebResources.closeSession(id)
        assertEquals(404, get("/doc/$id/after.html").status)
    }

    @Test
    fun assetsAreServedFromTheSessionBaseDir() {
        Files.createDirectories(baseDir.resolve("assets"))
        Files.write(baseDir.resolve("assets/doc.css"), "body { color: red }".toByteArray())
        val id = openSession()

        val response = get("/doc/$id/assets/doc.css")
        assertEquals(200, response.status)
        assertEquals("text/css", response.mimeType)
        assertEquals("body { color: red }", String(response.bytes))
    }

    @Test
    fun missingAssetsAnd404sNeverLeakThePath() {
        val id = openSession()
        assertEquals(404, get("/doc/$id/assets/nope.css").status)
    }

    @Test
    fun sessionsWithoutABaseDirServeNoAssets() {
        val id = openSession(baseDir = null)
        assertEquals(404, get("/doc/$id/anything.css").status)
    }

    @Test
    fun dotDotTraversalIsBlocked() {
        val id = openSession()
        val response = get("/doc/$id/../secret.txt")
        assertEquals(404, response.status)
        assertFalse(String(response.bytes).contains("TOP SECRET"))
    }

    @Test
    fun percentEncodedTraversalIsBlocked() {
        val id = openSession()
        assertEquals(404, get("/doc/$id/%2e%2e/secret.txt").status)
        assertEquals(404, get("/doc/$id/..%2Fsecret.txt").status)
        assertEquals(404, get("/doc/$id/%2E%2E%2Fsecret.txt").status)
    }

    @Test
    fun symlinkPointingOutsideTheBaseDirIsBlocked() {
        // A lexical normalize()+startsWith guard passes this one — only resolving the real path
        // catches it, which is exactly what the handler does.
        Files.createSymbolicLink(baseDir.resolve("link.css"), secret)
        val id = openSession()

        val response = get("/doc/$id/link.css")
        assertEquals(404, response.status)
        assertFalse(String(response.bytes).contains("TOP SECRET"))
    }

    @Test
    fun symlinkStayingInsideTheBaseDirIsServed() {
        Files.write(baseDir.resolve("real.css"), "a{}".toByteArray())
        Files.createSymbolicLink(baseDir.resolve("alias.css"), baseDir.resolve("real.css"))
        val id = openSession()

        val response = get("/doc/$id/alias.css")
        assertEquals(200, response.status)
        assertEquals("a{}", String(response.bytes))
    }

    @Test
    fun assetMimeTypesFollowTheExtension() {
        val expectations = mapOf(
            "a.css" to "text/css",
            "a.js" to "application/javascript",
            "a.svg" to "image/svg+xml",
            "a.png" to "image/png",
            "a.jpeg" to "image/jpeg",
            "a.woff2" to "font/woff2",
            "a.ico" to "image/x-icon",
            "a.json" to "application/json",
            "a.PNG" to "image/png", // extensions are matched case-insensitively
            "a.bin" to "application/octet-stream",
            "noextension" to "application/octet-stream",
        )
        expectations.keys.forEach { Files.write(baseDir.resolve(it), byteArrayOf(1)) }
        val id = openSession()

        for ((name, expected) in expectations) {
            assertEquals("MIME for $name", expected, get("/doc/$id/$name").mimeType)
        }
    }

    @Test
    fun everythingElseFallsThroughToTheBundledViewer() {
        // The shell page ships on the classpath (built by frontendBuild before tests run).
        val shell = get("/")
        assertEquals(200, shell.status)
        assertEquals("text/html", shell.mimeType)
        assertTrue(String(shell.bytes).contains("redline", ignoreCase = true))

        assertEquals(404, get("/no-such-resource.txt").status)
    }

    @Test
    fun viewerUrlCarriesSessionAndTheme() {
        assertEquals("http://redline.localhost/index.html?session=abc&theme=dark", RedlineWebResources.viewerUrl("abc", dark = true))
        assertEquals("http://redline.localhost/index.html?session=abc&theme=light", RedlineWebResources.viewerUrl("abc", dark = false))
    }
}
