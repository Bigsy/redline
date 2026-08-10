package com.hedworth.redline.jcef

import com.intellij.ui.jcef.JBCefApp

/**
 * JCEF availability check that also survives the classes being absent entirely.
 *
 * Since 2025.3.1 the JCEF classes ship in the separate "Web Browser (JCEF)" plugin, which Redline
 * depends on optionally (see plugin.xml). If that plugin is missing or disabled, JBCefApp is not
 * on our classloader and touching it throws [NoClassDefFoundError] — a plain
 * `JBCefApp.isSupported()` in [com.hedworth.redline.diff.RedlineDiffTool.canShow] would take down
 * the diff view.
 */
internal object JcefSupport {
    fun isAvailable(): Boolean =
        try {
            JBCefApp.isSupported()
        } catch (_: NoClassDefFoundError) {
            false
        }
}
