package org.rhea.workspace

import android.app.UiModeManager
import android.os.Build
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.BasicAlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

internal val rheaReading = FontFamily(Font(R.font.atkinson_regular), Font(R.font.atkinson_bold, FontWeight.Bold))
internal val rheaDisplay = FontFamily(Font(R.font.source_serif_display, FontWeight.Bold))
internal val rheaLiterary = FontFamily(Font(R.font.eb_garamond_italic, style = FontStyle.Italic))
internal val rheaMono = FontFamily(Font(R.font.plex_mono))

internal val RheaTypography = Typography(
    bodyLarge = TextStyle(fontFamily = rheaReading, fontSize = 18.sp, lineHeight = 30.sp),
    bodyMedium = TextStyle(fontFamily = rheaReading, fontSize = 15.sp, lineHeight = 22.sp),
    labelLarge = TextStyle(fontFamily = rheaReading, fontWeight = FontWeight.Bold, fontSize = 15.sp, lineHeight = 21.sp),
    labelMedium = TextStyle(fontFamily = rheaReading, fontSize = 13.sp, lineHeight = 18.sp),
    labelSmall = TextStyle(fontFamily = rheaMono, fontSize = 12.sp, lineHeight = 18.sp),
    titleMedium = TextStyle(fontFamily = rheaDisplay, fontWeight = FontWeight.Bold, fontSize = 18.sp, lineHeight = 24.sp),
    headlineSmall = TextStyle(fontFamily = rheaDisplay, fontWeight = FontWeight.Bold, fontSize = 24.sp, lineHeight = 30.sp),
)

internal fun rheaColors(paper: Boolean, palette: String): RheaPalette =
    if (paper) rheaPalettes.getValue("papel") else rheaPalettes[palette] ?: rheaPalettes.getValue("noite")

internal fun isPrismEnabled(authorial: Boolean, requested: Boolean, fontScale: Float, highContrast: Boolean): Boolean =
    authorial && requested && fontScale < 1.3f && !highContrast

internal fun useNavigationRail(widthDp: Float, fontScale: Float): Boolean =
    widthDp >= RheaExpandedNavigation && fontScale <= RheaExpandedFontScaleCeiling

@Composable
internal fun rheaHighContrast(): Boolean {
    val context = LocalContext.current
    return Build.VERSION.SDK_INT >= 34 &&
        (context.getSystemService(UiModeManager::class.java)?.contrast ?: 0f) > 0f
}

@Composable
internal fun glassAllowed(authorial: Boolean, requested: Boolean): Boolean =
    isPrismEnabled(authorial, requested, LocalConfiguration.current.fontScale, rheaHighContrast())

@Composable
internal fun RheaTheme(colors: RheaPalette, paper: Boolean, content: @Composable () -> Unit) {
    val outline = lerp(colors.outline, colors.muted, .44f)
    val scheme = (if (paper) lightColorScheme() else darkColorScheme()).copy(
        primary = colors.accent, onPrimary = colors.onAccent,
        secondary = colors.accent, onSecondary = colors.onAccent,
        secondaryContainer = colors.container, onSecondaryContainer = colors.heading,
        background = colors.background, onBackground = colors.ink, surface = colors.surface,
        onSurface = colors.ink, surfaceVariant = colors.container, onSurfaceVariant = colors.muted,
        outline = outline, outlineVariant = colors.rule,
        // Editorial accents stay in the palette across default control tones.
        surfaceContainer = colors.container, surfaceContainerLow = colors.surface,
        surfaceContainerHigh = colors.container,
    )
    MaterialTheme(colorScheme = scheme, typography = RheaTypography, content = content)
}

@Composable
internal fun PrismGlassSurface(
    colors: RheaPalette,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onDialog: Boolean = false,
    content: @Composable () -> Unit,
) {
    val shape = RoundedCornerShape(if (onDialog) 10.dp else 0.dp)
    val fill = if (enabled) colors.surface.copy(alpha = RheaGlassSurfaceAlpha) else colors.surface
    Box(modifier.background(fill, shape).border(1.dp, colors.rule, shape).drawWithContent {
        drawContent()
        if (enabled) {
            val inset = if (onDialog) 12.dp.toPx() else 1.dp.toPx()
            drawLine(colors.accent.copy(alpha = .24f), Offset(inset, 1.dp.toPx()), Offset(size.width - inset, 1.dp.toPx()))
        }
    }) { content() }
}

@Composable
internal fun RheaPrismMark(colors: RheaPalette, modifier: Modifier = Modifier, dial: Boolean = true) {
    Canvas(modifier) {
        val unit = minOf(size.width, size.height)
        val center = this.center
        val stroke = 1.dp.toPx()
        val edge = unit * .18f
        val outline = Path().apply {
            moveTo(center.x, center.y - edge)
            lineTo(center.x + edge, center.y)
            lineTo(center.x, center.y + edge)
            lineTo(center.x - edge, center.y)
            close()
        }
        if (dial) drawCircle(colors.outline, unit * .47f, style = Stroke(stroke))
        val beam = if (dial) unit * .34f else size.width * .46f
        drawLine(colors.accent.copy(alpha = .6f), Offset(center.x - beam, center.y), Offset(center.x + beam, center.y), stroke)
        drawPath(outline, colors.surface)
        drawPath(outline, colors.accent, style = Stroke(stroke))
        drawLine(colors.accent, Offset(center.x, center.y - edge * .76f), Offset(center.x, center.y + edge * .76f), stroke)
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun RheaContextDialog(
    colors: RheaPalette,
    glass: Boolean,
    onDismissRequest: () -> Unit,
    title: @Composable () -> Unit,
    text: @Composable () -> Unit,
    confirmButton: @Composable () -> Unit,
    dismissButton: @Composable () -> Unit,
) {
    BasicAlertDialog(onDismissRequest = onDismissRequest) {
        PrismGlassSurface(colors, glass, Modifier.fillMaxWidth(), onDialog = true) {
            Column(Modifier.heightIn(max = 560.dp).verticalScroll(rememberScrollState()).padding(20.dp)) {
                title()
                Spacer(Modifier.height(10.dp))
                text()
                Spacer(Modifier.height(12.dp))
                FlowRow(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                ) {
                    dismissButton()
                    confirmButton()
                }
            }
        }
    }
}
