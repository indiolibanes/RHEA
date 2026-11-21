import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val workspaceOrigin = providers.gradleProperty("rheaWorkspaceOrigin").orElse("").get()
val workspaceUrl = if (workspaceOrigin.isEmpty()) "" else {
    val origin = URI(workspaceOrigin)
    require(origin.scheme == "https" && origin.host != null && origin.rawUserInfo == null &&
        origin.rawPath.isEmpty() && origin.rawQuery == null && origin.rawFragment == null) {
        "rheaWorkspaceOrigin must be an HTTPS origin without a trailing slash."
    }
    "$origin/rhea"
}

android {
    namespace = "org.rhea.workspace"
    compileSdk = 35
    defaultConfig {
        applicationId = "org.rhea.workspace"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1-local"
        buildConfigField("String", "RHEA_WORKSPACE_URL", "\"$workspaceUrl\"")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}
kotlin {
    jvmToolchain(21)
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}
dependencies {
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation(platform("androidx.compose:compose-bom:2025.04.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui-tooling-preview")
    testImplementation("junit:junit:4.13.2")
}
