package org.rhea.workspace

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.edit
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private var incoming by mutableStateOf<List<Uri>>(emptyList())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        incoming = sharedUris(intent)
        enableEdgeToEdge()
        setContent { RheaScreen(incoming) { incoming = emptyList() } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        incoming = sharedUris(intent)
    }
}

private val minimumControl = Modifier.heightIn(min = RheaControlMin.dp)

private val initialFiles = listOf(
    RheaDoc("Amostra de malha.glb", "model/gltf-binary", 17L * 1024 * 1024, Tier.TEMPORARY, "Expira amanhã"),
    RheaDoc("Caderno de órbita.zip", "application/zip", 61L * 1024 * 1024, Tier.ACTIVE, "Disponível"),
    RheaDoc("Caderno de referência.pdf", "application/pdf", 100L * 1024, Tier.CANONICAL, "Protegido"),
    RheaDoc("Rascunho de trajetória.txt", "text/plain", 120, Tier.TEMPORARY, "Expirado"),
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RheaScreen(incoming: List<Uri>, consumeIncoming: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val preferences = remember(context) { context.getSharedPreferences("appearance", MODE_PRIVATE_FLAGS) }
    var profile by rememberSaveable { mutableStateOf("oficina") }
    var mode by rememberSaveable { mutableStateOf(preferences.getString("mode", "autoral") ?: "autoral") }
    var palette by rememberSaveable { mutableStateOf(preferences.getString("palette", "noite") ?: "noite") }
    var paper by rememberSaveable { mutableStateOf(preferences.getBoolean("paper", false)) }
    var prism by rememberSaveable { mutableStateOf(preferences.getBoolean("prism", false)) }
    var expanded by rememberSaveable { mutableStateOf(false) }
    var selectedTier by rememberSaveable { mutableStateOf(Tier.TEMPORARY) }
    var selected by remember { mutableStateOf<RheaDoc?>(null) }
    var destinationFile by remember { mutableStateOf<RheaDoc?>(null) }
    var uris by remember { mutableStateOf(emptyList<Uri>()) }
    var notice by remember { mutableStateOf("") }
    var transferring by remember { mutableStateOf(false) }
    var progress by remember { mutableStateOf<Float?>(null) }
    val imported = remember { mutableStateListOf<Pair<String, RheaDoc>>() }
    val replaced = remember { mutableStateListOf<RheaDoc>() }

    val browse = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { documents ->
        uris = documents.filter { it.scheme == "content" }.distinct().take(8)
    }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val file = destinationFile?.backing
        destinationFile = null
        if (uri != null && file != null) scope.launch {
            notice = try { saveDocument(context, file, uri); "Salvo no destino escolhido." }
            catch (error: CancellationException) { throw error }
            catch (_: Exception) { "Não foi possível gravar no destino." }
        }
    }

    LaunchedEffect(incoming) {
        if (incoming.isNotEmpty()) {
            if (transferring) notice = "Aguarde a transferência atual e compartilhe de novo."
            else uris = incoming
            consumeIncoming()
        }
    }
    LaunchedEffect(mode, palette, paper, prism) {
        preferences.edit {
            putString("mode", mode)
            putString("palette", palette)
            putBoolean("paper", paper)
            putBoolean("prism", prism)
        }
    }

    val colors = rheaColors(paper, palette)
    val authorial = mode == "autoral"
    val glass = glassAllowed(authorial, prism)
    val typography = RheaTypography
    RheaTheme(colors, paper) {
        RheaFrame(
            colors = colors, authorial = authorial, glass = glass, settingsOpen = expanded,
            toggleSettings = { expanded = !expanded },
            settings = {
                FlowRow(Modifier.padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedButton({ mode = if (authorial) "serio" else "autoral" }, minimumControl) {
                        Text(if (authorial) "Modo sério" else "Modo autoral")
                    }
                    OutlinedButton({ paper = !paper }, minimumControl, shape = RheaActionShape) { Text(if (paper) "Tema escuro" else "Tema claro") }
                    OutlinedButton({ prism = !prism }, minimumControl) {
                        Text(if (prism) "Vidro prismático ligado" else "Vidro prismático desligado")
                    }
                    if (!paper) for ((id, label) in listOf("noite" to "Noite", "ametista" to "Ametista", "esmeralda" to "Esmeralda")) {
                        OutlinedButton({ palette = id }, minimumControl, shape = RheaActionShape) { Text(if (palette == id) "✓ $label" else label) }
                    }
                }
            },
            profile = {
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 6.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Conta de demonstração: " + if (profile == "oficina") "Oficina" else "Arquivo",
                        color = colors.muted, style = typography.bodyMedium, modifier = Modifier.weight(1f))
                    TextButton(onClick = {
                        uris = emptyList(); selected = null
                        profile = if (profile == "oficina") "arquivo" else "oficina"
                        notice = "Conta de demonstração alterada."
                    }, enabled = !transferring, modifier = minimumControl, shape = RheaActionShape) { Text("Trocar") }
                }
                Rule(colors)
            },
            intake = { rail ->
                Column(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp)) {
                    val width = if (rail) Modifier.widthIn(max = 270.dp) else Modifier
                    Button({ browse.launch(arrayOf("*/*")) }, minimumControl.then(width).fillMaxWidth(),
                        enabled = !transferring, shape = RheaActionShape) { Text("Selecionar arquivos") }
                    Text("Você também pode compartilhar a partir de outro app.",
                        Modifier.padding(top = 5.dp), style = typography.labelMedium, color = colors.muted)
                }
                if (transferring) {
                    PrismGlassSurface(colors, glass, Modifier.fillMaxWidth().padding(top = 8.dp)) {
                        Column(Modifier.padding(12.dp)) {
                            Text("Copiando para a RHEA neste dispositivo…", modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                            if (progress != null) {
                                LinearProgressIndicator(progress = { progress ?: 0f },
                                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                            }
                        }
                    }
                }
                if (notice.isNotEmpty()) Text(notice, color = colors.muted, style = typography.bodyMedium,
                    modifier = Modifier.padding(top = 8.dp).semantics { liveRegion = LiveRegionMode.Polite })
            },
            files = { rail ->
                SectionHeading("Arquivos recentes", colors)
                Rule(colors)
                val visible = imported.asReversed().filter { it.first == profile }.map { it.second } +
                    if (profile == "oficina") initialFiles.map { seed -> replaced.firstOrNull { it.name == seed.name } ?: seed } else emptyList()
                if (visible.isEmpty()) Text("Nenhum arquivo nesta conta.", modifier = Modifier.padding(vertical = 12.dp), color = colors.muted)
                for (file in visible) {
                    val status = "${file.tier.symbol} ${file.tier.label} · ${file.status}"
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 5.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f).padding(vertical = 5.dp)) {
                            Text(file.name, style = typography.titleMedium, color = colors.heading)
                            Text("${file.name.substringAfterLast('.', file.mime).uppercase()} · ${formatSize(file.size)}",
                                style = typography.labelSmall, color = colors.muted)
                            if (!rail) Text(status, style = typography.bodyMedium, color = colors.muted)
                        }
                        if (rail) Text(status, style = typography.bodyMedium, color = colors.muted, modifier = Modifier.weight(.50f))
                        TextButton({ selected = file }, minimumControl, shape = RheaActionShape) { Text("Detalhes") }
                    }
                    Rule(colors)
                }
            },
            links = {
                SectionHeading("Links temporários", colors)
                HorizontalDivider(color = colors.rule)
                Text("Na RHEA web, você pode acessar o Drive e abrir prévias.",
                    style = typography.bodyMedium, color = colors.muted, modifier = Modifier.padding(top = 8.dp))
                if (BuildConfig.RHEA_WORKSPACE_URL.isNotEmpty()) {
                    TextButton(
                        onClick = {
                            try {
                                val workspace = Uri.parse(BuildConfig.RHEA_WORKSPACE_URL)
                                context.startActivity(Intent(Intent.ACTION_VIEW, workspace))
                            } catch (_: ActivityNotFoundException) {
                                notice = "Nenhum navegador está disponível para abrir a RHEA."
                            }
                        },
                        modifier = minimumControl,
                    ) { Text("Abrir a RHEA web ↗") }
                }
            },
        )

        if (uris.isNotEmpty()) {
            RheaContextDialog(
                colors = colors, glass = glass,
                onDismissRequest = { uris = emptyList() },
                title = { Text("Guardar ${uris.size} arquivo(s)", style = typography.headlineSmall) },
                text = {
                    Column {
                        Text("Escolha a conservação para copiar nesta demonstração.")
                        val providers = remember(uris) { uris.mapNotNull { providerLabel(context, it) }.distinct() }
                        if (providers.isNotEmpty()) Text("Origem: " + providers.joinToString(", "), style = typography.labelMedium, color = colors.muted)
                        for (tier in Tier.entries) {
                            TextButton({ selectedTier = tier }, minimumControl) {
                                Text("${if (tier == selectedTier) "✓ " else ""}${tier.label}")
                            }
                        }
                    }
                },
                confirmButton = {
                    Button(onClick = {
                        val batch = uris
                        val owner = profile
                        val tier = selectedTier
                        uris = emptyList()
                        transferring = true
                        progress = null
                        scope.launch {
                            var success = 0
                            try {
                                for (uri in batch) {
                                    try {
                                        val file = importDocument(context, owner, uri, tier) { count, total ->
                                            withContext(Dispatchers.Main) {
                                                progress = total?.takeIf { it > 0 }?.let { (count.toFloat() / it).coerceAtMost(1f) }
                                            }
                                        }
                                        imported += owner to file
                                        success++
                                    } catch (error: CancellationException) { throw error }
                                    catch (_: Exception) { /* Batch continues with the remaining grants. */ }
                                }
                                notice = if (success == batch.size) "$success arquivo(s) copiado(s) para a RHEA neste dispositivo."
                                else "$success de ${batch.size} arquivo(s) copiado(s). Verifique acesso e espaço."
                            } finally { transferring = false; progress = null }
                        }
                    }, modifier = minimumControl, shape = RheaActionShape) { Text("Guardar arquivos") }
                },
                dismissButton = { TextButton({ uris = emptyList() }, minimumControl, shape = RheaActionShape) { Text("Cancelar") } },
            )
        }

        selected?.let { file ->
            var confirmCanonical by remember(file) { mutableStateOf(false) }
            RheaContextDialog(
                colors = colors, glass = glass,
                onDismissRequest = { selected = null },
                title = { Text(file.name, style = typography.headlineSmall) },
                text = {
                    Column {
                        Text("${file.tier.label} · ${file.status}")
                        if (file.tier == Tier.CANONICAL) Text("Protegido de expiração e exclusão direta.")
                        if (confirmCanonical) Text("Mover para Ativo remove a proteção contra exclusão.")
                        if (file.backing != null) {
                            TextButton({
                                destinationFile = file
                                save.launch(file.name)
                            }, minimumControl, shape = RheaActionShape) { Text("Salvar em…") }
                            TextButton({ runCatching { handoff(context, file, false) }.onFailure { notice = "Nenhum app abriu o arquivo." } },
                                minimumControl) { Text("Abrir com…") }
                            TextButton({ runCatching { handoff(context, file, true) }.onFailure { notice = "Não foi possível compartilhar." } },
                                minimumControl) { Text("Compartilhar") }
                        } else Text("Item sintético de visualização.", color = colors.muted)
                    }
                },
                confirmButton = {
                    if (file.tier == Tier.CANONICAL) {
                        TextButton({
                            if (!confirmCanonical) confirmCanonical = true
                            else {
                                val updated = file.copy(tier = Tier.ACTIVE, status = if (file.backing != null) file.status else "Disponível")
                                if (file.backing != null) {
                                    val index = imported.indexOf(profile to file)
                                    if (index >= 0) imported[index] = profile to updated
                                } else {
                                    replaced.removeAll { it.name == file.name }
                                    replaced += updated
                                }
                                selected = null
                            }
                        }, minimumControl, shape = RheaActionShape) { Text(if (confirmCanonical) "Confirmar" else "Mover para ativo") }
                    } else TextButton({ selected = null }, minimumControl, shape = RheaActionShape) { Text("Fechar") }
                },
                dismissButton = { if (file.tier == Tier.CANONICAL) TextButton({ selected = null }, minimumControl, shape = RheaActionShape) { Text("Fechar") } },
            )
        }
    }
}

private const val MODE_PRIVATE_FLAGS = android.content.Context.MODE_PRIVATE

@Composable
private fun Rule(colors: RheaPalette) = HorizontalDivider(color = colors.rule)

@Composable
private fun SectionHeading(title: String, colors: RheaPalette) {
    Text(title, Modifier.padding(top = 14.dp, bottom = 5.dp).semantics { heading() },
        style = MaterialTheme.typography.headlineSmall, color = colors.heading)
}
