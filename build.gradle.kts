import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

fun usesUnifiedIntelliJIdea(version: String): Boolean {
    fun numericPart(value: String): Int? = value.takeWhile(Char::isDigit).toIntOrNull()

    val parts = version.split('.')
    val first = parts.firstOrNull()?.let(::numericPart) ?: return false
    return if (first >= 2000) {
        first > 2025 || (first == 2025 && (parts.getOrNull(1)?.let(::numericPart) ?: 0) >= 3)
    } else {
        first >= 253
    }
}

// Redline — IntelliJ plugin: a rendered HTML diff (redline) viewer. Registers a FrameDiffTool
// that, when both sides of a diff are HTML, shows the rendered document with changes highlighted
// in a JCEF pane instead of a text diff.
//
// Build layout mirrors MilkJ: frontend/ (Vite + TS) builds into src/main/resources/web/.

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.3.21"
    id("org.jetbrains.intellij.platform") version "2.17.0"
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
        // The vendored htmldiff.js is MIT; ship its license with the bundle that embeds it.
        from("frontend/src/vendor/node-htmldiff-LICENSE") {
            into("third-party")
        }
    }
}
