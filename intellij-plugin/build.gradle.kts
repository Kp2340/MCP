plugins {
    id("org.jetbrains.intellij.platform") version "2.3.0"
    kotlin("jvm") version "1.9.25"
}

group   = "in.decorom"
version = "1.1.0"

kotlin {
    jvmToolchain(17)
}

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    implementation("org.json:json:20240303")
    intellijPlatform {
        intellijIdeaCommunity("2024.1.7")
        pluginVerifier()
        zipSigner()
    }
}

intellijPlatform {
    pluginConfiguration {
        version = "1.1.0"
        ideaVersion {
            sinceBuild = "241"
            untilBuild = provider { null }
        }
    }
    signing {
        certificateChain = System.getenv("CERTIFICATE_CHAIN") ?: ""
        privateKey        = System.getenv("PRIVATE_KEY") ?: ""
        password          = System.getenv("PRIVATE_KEY_PASSWORD") ?: ""
    }
    publishing {
        token = System.getenv("PUBLISH_TOKEN") ?: ""
    }
    instrumentCode = false
}

tasks {
    buildSearchableOptions { enabled = false }
    prepareSandbox {
        pluginJar.set(jar.flatMap { it.archiveFile })
    }

}
