package org.rhea.workspace

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

internal val RheaActionShape = RoundedCornerShape(4.dp)

private enum class Destination(val item: Int, val namePt: String) {
    INTAKE(0, "Enviar"), FILES(2, "Recentes"), LINKS(3, "Links"),
}

@Composable
internal fun RheaFrame(
    colors: RheaPalette,
    authorial: Boolean,
    glass: Boolean,
    settingsOpen: Boolean,
    toggleSettings: () -> Unit,
    settings: @Composable () -> Unit,
    profile: @Composable () -> Unit,
    intake: @Composable (Boolean) -> Unit,
    files: @Composable (Boolean) -> Unit,
    links: @Composable () -> Unit,
) {
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    var destination by rememberSaveable { mutableStateOf(Destination.INTAKE) }
    val select: (Destination) -> Unit = { page ->
        destination = page
        scope.launch { list.scrollToItem(page.item) }
    }
    BoxWithConstraints(Modifier.fillMaxSize().background(colors.background).safeDrawingPadding()) {
        val rail = useNavigationRail(maxWidth.value, LocalConfiguration.current.fontScale)
        Column {
            PrismGlassSurface(colors, glass, Modifier.fillMaxWidth()) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = if (rail) 24.dp else 16.dp, vertical = 3.dp),
                    horizontalArrangement = Arrangement.spacedBy(9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RheaPrismMark(colors, Modifier.size(29.dp))
                    Text("RHEA", modifier = Modifier.weight(1f), fontFamily = rheaDisplay,
                        fontWeight = FontWeight.Bold, fontSize = 13.sp, letterSpacing = .55.sp,
                        color = colors.heading)
                    TextButton(
                        onClick = {
                            toggleSettings()
                            if (!settingsOpen) scope.launch { list.scrollToItem(0) }
                        },
                        shape = RheaActionShape,
                        modifier = Modifier.heightIn(min = RheaControlMin.dp),
                    ) { Text(if (settingsOpen) "Fechar" else "Aparência") }
                }
            }
            Row(Modifier.weight(1f)) {
                if (rail) {
                    PrismGlassSurface(colors, glass, Modifier.width(150.dp).fillMaxHeight()) {
                        Column(Modifier.padding(top = 24.dp, start = 14.dp, end = 14.dp).selectableGroup()) {
                            for (page in Destination.entries) {
                                RheaDestination(page, destination == page, colors, { select(page) }, Modifier.fillMaxWidth(), true)
                            }
                        }
                    }
                }
                Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.TopCenter) {
                    LazyColumn(
                        state = list,
                        modifier = Modifier.widthIn(max = 890.dp).fillMaxSize()
                            .padding(horizontal = if (rail) 30.dp else 16.dp),
                    ) {
                        item(key = "intro") {
                            if (settingsOpen) {
                                settings()
                                profile()
                            }
                            RheaCover(colors, authorial, rail)
                        }
                        item(key = "intake") { intake(rail) }
                        item(key = "files") { files(rail) }
                        item(key = "links") { links(); Spacer(Modifier.height(24.dp)) }
                    }
                }
            }
            if (!rail) {
                PrismGlassSurface(colors, glass, Modifier.fillMaxWidth()) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp).selectableGroup()) {
                        for (page in Destination.entries) {
                            RheaDestination(page, destination == page, colors, { select(page) }, Modifier.weight(1f), false)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RheaCover(colors: RheaPalette, authorial: Boolean, rail: Boolean) {
    val artwork = authorial && LocalConfiguration.current.fontScale < 1.3f && !rheaHighContrast()
    val paper = colors == rheaPalettes.getValue("papel")
    Box(Modifier.fillMaxWidth().padding(top = 14.dp).background(colors.surface)) {
        if (artwork) {
            val width = if (rail) Modifier.widthIn(max = 290.dp).fillMaxWidth() else Modifier.fillMaxWidth(.49f)
            Box(Modifier.align(Alignment.CenterEnd).then(width).height(if (rail) 119.dp else 109.dp)
                .background(Brush.horizontalGradient(
                    0f to colors.surface,
                    1f to colors.accent.copy(alpha = if (paper) .14f else .22f),
                )))
        }
        Column(Modifier.fillMaxWidth(if (artwork) .68f else 1f).padding(horizontal = 14.dp, vertical = 15.dp)) {
            Spacer(Modifier.width(23.dp).height(2.dp).background(colors.accent))
            Text("RHEA", Modifier.semantics { heading() },
                fontFamily = if (authorial) rheaLiterary else rheaDisplay,
                fontSize = if (rail) 59.sp else 50.sp,
                fontWeight = if (authorial) FontWeight.Normal else FontWeight.Bold,
                fontStyle = if (authorial) FontStyle.Italic else FontStyle.Normal,
                lineHeight = if (rail) 65.sp else 55.sp, color = colors.heading)
            Text("Arquivos entre dispositivos.", style = MaterialTheme.typography.bodyMedium, color = colors.muted)
        }
        HorizontalDivider(Modifier.align(Alignment.BottomCenter), color = colors.rule)
    }
}

@Composable
private fun RheaDestination(
    page: Destination,
    selected: Boolean,
    colors: RheaPalette,
    onSelect: () -> Unit,
    modifier: Modifier,
    rail: Boolean,
) {
    val ink = if (selected) colors.accent else colors.muted
    Box(
        modifier.heightIn(min = RheaControlMin.dp).selectable(selected, role = Role.Tab, onClick = onSelect),
        contentAlignment = if (rail) Alignment.CenterStart else Alignment.Center,
    ) {
        val marker = if (rail) Modifier.align(Alignment.CenterStart).width(2.dp).height(19.dp)
            else Modifier.align(Alignment.TopCenter).width(21.dp).height(2.dp)
        if (selected) Spacer(marker.background(ink))
        Text(page.namePt, Modifier.padding(horizontal = if (rail) 12.dp else 3.dp, vertical = 10.dp),
            style = MaterialTheme.typography.labelLarge, textAlign = if (rail) TextAlign.Start else TextAlign.Center,
            color = ink)
    }
}

@Preview(name = "Phone · Noite · Editorial", widthDp = 360, heightDp = 800, showBackground = true)
@Composable
private fun PhoneEditorial() = RheaFramePreview(false, "noite", false, true)

@Preview(name = "Phone · Ametista · Prism Glass", widthDp = 390, heightDp = 840, showBackground = true)
@Composable
private fun PhonePrism() = RheaFramePreview(false, "ametista", true, true)

@Preview(name = "Tablet · Esmeralda · Prism Glass", widthDp = 980, heightDp = 740, showBackground = true)
@Composable
private fun TabletPrism() = RheaFramePreview(false, "esmeralda", true, true)

@Preview(name = "Split screen · Papel · Sério", widthDp = 560, heightDp = 800, fontScale = 1.5f, showBackground = true)
@Composable
private fun SplitPaper() = RheaFramePreview(true, "noite", false, false)

@Composable
private fun RheaFramePreview(paper: Boolean, palette: String, glass: Boolean, authorial: Boolean) {
    val colors = rheaColors(paper, palette)
    RheaTheme(colors, paper) {
        RheaFrame(colors, authorial, glass, false, {}, {},
            profile = { Text("Conta de demonstração: Oficina", Modifier.padding(bottom = 8.dp)) },
            intake = {
                Text("Enviar", Modifier.padding(top = 14.dp), style = MaterialTheme.typography.headlineSmall, color = colors.heading)
                PrismGlassSurface(colors, glass, Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Button({}, Modifier.padding(12.dp).heightIn(min = RheaControlMin.dp), shape = RheaActionShape) { Text("Selecionar arquivos") }
                }
            },
            files = {
                Text("Arquivos recentes", Modifier.padding(vertical = 14.dp), style = MaterialTheme.typography.headlineSmall, color = colors.heading)
                listOf("Caderno de órbita.zip" to "Ativo · Disponível", "星の記録 — caderno de referência.pdf" to "Canônico · Protegido").forEach { (name, status) ->
                    HorizontalDivider(color = colors.rule)
                    Column(Modifier.padding(vertical = 8.dp)) {
                        Text(name, style = MaterialTheme.typography.titleMedium, color = colors.heading)
                        Text(status, style = MaterialTheme.typography.bodyMedium, color = colors.muted)
                    }
                }
            },
            links = { Text("Links temporários", Modifier.padding(top = 14.dp), style = MaterialTheme.typography.headlineSmall, color = colors.heading) },
        )
    }
}
