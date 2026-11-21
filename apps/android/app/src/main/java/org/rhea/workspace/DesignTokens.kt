package org.rhea.workspace

import androidx.compose.ui.graphics.Color

internal data class RheaPalette(
    val background: Color,
    val surface: Color,
    val container: Color,
    val ink: Color,
    val heading: Color,
    val muted: Color,
    val accent: Color,
    val onAccent: Color,
    val outline: Color,
    val rule: Color,
)

internal const val RheaControlMin = 48
internal const val RheaGlassSurfaceAlpha = 0.92f
internal const val RheaExpandedNavigation = 720
internal const val RheaExpandedFontScaleCeiling = 1.55f

internal val rheaPalettes = mapOf(
    "noite" to RheaPalette(
        background = Color(0xFF0E0D0A),
        surface = Color(0xFF17150F),
        container = Color(0xFF1F1C14),
        ink = Color(0xFFF0EADB),
        heading = Color(0xFFFFF1B4),
        muted = Color(0xFFC7BFA9),
        accent = Color(0xFFE2C35C),
        onAccent = Color(0xFF3B2F00),
        outline = Color(0xFF6E6652),
        rule = Color(0xFF4C4638),
    ),
    "ametista" to RheaPalette(
        background = Color(0xFF0E1022),
        surface = Color(0xFF151730),
        container = Color(0xFF1C1F3B),
        ink = Color(0xFFF0EADB),
        heading = Color(0xFFFFF1B4),
        muted = Color(0xFFC7BFA9),
        accent = Color(0xFFE2C35C),
        onAccent = Color(0xFF3B2F00),
        outline = Color(0xFF7075A3),
        rule = Color(0xFF444A75),
    ),
    "esmeralda" to RheaPalette(
        background = Color(0xFF09140F),
        surface = Color(0xFF0F1D17),
        container = Color(0xFF152720),
        ink = Color(0xFFF0EADB),
        heading = Color(0xFFFFF1B4),
        muted = Color(0xFFC7BFA9),
        accent = Color(0xFFE2C35C),
        onAccent = Color(0xFF3B2F00),
        outline = Color(0xFF608579),
        rule = Color(0xFF37564A),
    ),
    "papel" to RheaPalette(
        background = Color(0xFFF6EFDC),
        surface = Color(0xFFFFFAF0),
        container = Color(0xFFF1E7CF),
        ink = Color(0xFF2C271D),
        heading = Color(0xFF4D3A09),
        muted = Color(0xFF6D624E),
        accent = Color(0xFF826414),
        onAccent = Color(0xFFFFF5D4),
        outline = Color(0xFF9D8E70),
        rule = Color(0xFFC9BDA5),
    ),
)
