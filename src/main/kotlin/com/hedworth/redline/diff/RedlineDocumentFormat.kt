package com.hedworth.redline.diff

/**
 * The representation that Redline receives for a comparison.
 *
 * HTML is deliberately the default in the web resource API and viewer URL so existing callers
 * keep the same behaviour. Markdown is converted by the web client before it enters the existing
 * sanitization and diff pipeline.
 */
enum class RedlineDocumentFormat(val queryValue: String) {
    HTML("html"),
    MARKDOWN("markdown"),
}
