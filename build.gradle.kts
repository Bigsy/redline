import org.jetbrains.changelog.Changelog
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

/** Accept both release versions (2026.2.1) and platform build numbers (262.x). */
fun isPlatformAtLeast(version: String, year: Int, minor: Int, build: Int): Boolean {
    fun numericPart(value: String): Int? = value.takeWhile(Char::isDigit).toIntOrNull()

    val parts = version.split('.')
    val first = parts.firstOrNull()?.let(::numericPart) ?: return false
    return if (first >= 2000) {
        first > year || (first == year && (parts.getOrNull(1)?.let(::numericPart) ?: 0) >= minor)
    } else {
        first >= build
    }
}

fun usesUnifiedIntelliJIdea(version: String): Boolean = isPlatformAtLeast(version, 2025, 3, 253)

fun hasSeparateJcefPlugin(version: String): Boolean = isPlatformAtLeast(version, 2026, 2, 262)

// Redline — IntelliJ plugin: a rendered HTML/Markdown diff viewer. Registers a FrameDiffTool
// that, when both sides have a supported format, shows the rendered document with changes highlighted
// in a JCEF pane instead of a text diff.
//
// Build layout mirrors MilkJ: frontend/ (Vite + TS) builds into src/main/resources/web/.

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.3.21"
    id("org.jetbrains.intellij.platform") version "2.17.0"
    id("org.jetbrains.changelog") version "2.5.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()

    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        val platformVersion = providers.gradleProperty("platformVersion")
        val platformType = providers.gradleProperty("platformType").zip(platformVersion) { type, version ->
            val requested = IntelliJPlatformType.fromCode(type)
            if (requested == IntelliJPlatformType.IntellijIdeaCommunity && usesUnifiedIntelliJIdea(version)) {
                IntelliJPlatformType.IntellijIdea
            } else {
                requested
            }
        }
        create(
            platformType,
            platformVersion,
        )
        // From 2026.2, JCEF is a separate bundled plugin. plugin.xml declares the optional
        // runtime dependency; Gradle also needs it on the compile/runIde classpath. Older
        // targets provide these classes in the platform and have no bundled JCEF plugin.
        bundledPlugins(platformVersion.map { version ->
            if (hasSeparateJcefPlugin(version)) listOf("com.intellij.modules.jcef") else emptyList()
        })

        pluginVerifier()
        zipSigner()
        testFramework(TestFrameworkType.Platform)
    }

    // BasePlatformTestCase is JUnit3/4-based; the platform test framework doesn't bring JUnit itself.
    testImplementation("junit:junit:4.13.2")
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")

        // Change notes come from CHANGELOG.md (single source; plugin.xml has no <change-notes>).
        // The section matching pluginVersion is used when it exists, so a release shows its own
        // notes; until CHANGELOG's [Unreleased] is moved under a version heading (see README
        // "Releasing") the unreleased section is rendered instead, which is what a local
        // buildPlugin between releases should show.
        // Zip the parsed-changelog PROVIDER rather than calling `changelog.getOrNull(...)` inside
        // the lambda: the extension accessor resolves through the Project, which the configuration
        // cache refuses to serialize.
        changeNotes = changelog.instance.zip(providers.gradleProperty("pluginVersion")) { log, pluginVersion ->
            val item = log.items[pluginVersion]
                ?: log.unreleasedItem
                ?: error("CHANGELOG.md has neither a [$pluginVersion] section nor an [Unreleased] one")
            log.renderItem(item.withHeader(false).withEmptySections(false), Changelog.OutputType.HTML)
        }

        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null } // open-ended; see gradle.properties
        }
    }

    // Signing + publishing read from environment variables in CI.
    signing {
        certificateChain = providers.environmentVariable("CERTIFICATE_CHAIN")
        privateKey = providers.environmentVariable("PRIVATE_KEY")
        password = providers.environmentVariable("PRIVATE_KEY_PASSWORD")
    }

    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN")
    }

    pluginVerification {
        ides {
            recommended()
        }
    }
}

// CHANGELOG.md is Keep-a-Changelog: `## [Unreleased]`, then `## [x.y.z] — date` sections with
// Added/Changed/… groups and compare links at the bottom. The release workflow reads the section
// for the tagged version with `getChangelog --project-version=…`.
changelog {
    repositoryUrl = providers.gradleProperty("pluginRepositoryUrl")
}

kotlin {
    jvmToolchain(providers.gradleProperty("javaVersion").get().toInt())

    compilerOptions {
        // Platform 2024.1 bundles the Kotlin 1.9 stdlib; pinning apiVersion makes 2.x-only stdlib
        // APIs fail at compile time instead of NoSuchMethodError at runtime on older IDEs.
        apiVersion = org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_1_9
    }
}

val frontendInstall = tasks.register<Exec>("frontendInstall") {
    workingDir = layout.projectDirectory.dir("frontend").asFile
    commandLine("pnpm", "install", "--frozen-lockfile")
    environment("CI", "true")

    inputs.file("frontend/package.json")
    inputs.file("frontend/pnpm-lock.yaml")
    inputs.file("frontend/pnpm-workspace.yaml")
    outputs.dir("frontend/node_modules")
    // pnpm's node_modules is symlinks into the global store; snapshotting it for the build cache
    // is fragile (and huge). Up-to-date checks via the outputs still work.
    outputs.cacheIf { false }
}

val frontendTest = tasks.register<Exec>("frontendTest") {
    dependsOn(frontendInstall)
    workingDir = layout.projectDirectory.dir("frontend").asFile
    commandLine("pnpm", "run", "test")
    environment("CI", "true")

    inputs.file("frontend/package.json")
    inputs.file("frontend/pnpm-lock.yaml")
    inputs.file("frontend/tsconfig.json")
    inputs.file("frontend/vite.config.ts")
    inputs.dir("frontend/src")
    // corpus.test.ts reads the committed synthetic corpus.
    inputs.dir("testdata/mock")
    inputs.dir("testdata/markdown")
    // Exec has no outputs; record a marker so up-to-date checks skip unchanged reruns.
    val marker = layout.buildDirectory.file("frontendTest.marker")
    outputs.file(marker)
    doLast { marker.get().asFile.writeText("ok") }
}

val frontendBuild = tasks.register<Exec>("frontendBuild") {
    dependsOn(frontendInstall, frontendTest)
    workingDir = layout.projectDirectory.dir("frontend").asFile
    commandLine("pnpm", "run", "build")
    environment("CI", "true")

    inputs.file("frontend/index.html")
    inputs.file("frontend/package.json")
    inputs.file("frontend/pnpm-lock.yaml")
    inputs.file("frontend/pnpm-workspace.yaml")
    inputs.file("frontend/tsconfig.json")
    inputs.file("frontend/vite.config.ts")
    inputs.dir("frontend/src")
    outputs.dir("src/main/resources/web")
}

tasks {
    processResources {
        dependsOn(frontendBuild)
        // Notices for the bundled engine, Markdown renderer, and their runtime dependencies.
        from("third-party") {
            into("third-party")
        }
    }
}
