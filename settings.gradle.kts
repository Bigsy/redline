// Auto-provisions the JDK declared by the Kotlin toolchain (Java 17) if it isn't installed locally.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
}

rootProject.name = "redline"
