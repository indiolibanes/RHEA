package org.rhea.workspace

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import java.io.File
import java.io.IOException
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal const val CandidateCap = 512L * 1024 * 1024
private const val LocalBudget = 640L * 1024 * 1024

internal enum class Tier(val label: String, val symbol: String) {
    TEMPORARY("Temporário", "◷"), ACTIVE("Ativo", "◇"), CANONICAL("Canônico", "▣"),
}

internal data class RheaDoc(
    val name: String,
    val mime: String,
    val size: Long,
    val tier: Tier,
    val status: String,
    val backing: File? = null,
)

internal fun cleanDocumentName(value: String): String =
    value.replace(Regex("[\\x00-\\x1f\\x7f/\\\\\\u202a-\\u202e\\u2066-\\u2069]"), "_")
        .trim().take(150).trimEnd { Character.isHighSurrogate(it) }
        .takeUnless { it.isBlank() || it == "." || it == ".." } ?: "arquivo"

internal fun formatSize(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val unit = if (bytes < 1024 * 1024) "KiB" else "MiB"
    val divisor = if (unit == "KiB") 1024.0 else (1024 * 1024).toDouble()
    return String.format(Locale.forLanguageTag("pt-BR"), "%.1f %s", bytes / divisor, unit)
}

internal fun sharedUris(intent: Intent?): List<Uri> {
    if (intent == null || intent.action !in setOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) return emptyList()
    val uris = mutableListOf<Uri>()
    intent.clipData?.let { clip ->
        (0 until clip.itemCount).mapNotNullTo(uris) { clip.getItemAt(it).uri }
    }
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
        uris += IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
    } else {
        IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(uris::add)
    }
    return uris.filter { it.scheme == "content" }.distinct().take(8)
}

internal fun providerLabel(context: Context, uri: Uri): String? {
    val authority = uri.authority ?: return null
    val manager = context.packageManager
    return manager.resolveContentProvider(authority, 0)?.loadLabel(manager)?.toString()?.takeIf(String::isNotBlank)
}

private fun Context.rheaDirectory(account: String) = File(filesDir, "rhea-local/$account")
    .also { check(it.isDirectory || it.mkdirs()) }

internal suspend fun importDocument(
    context: Context,
    account: String,
    uri: Uri,
    tier: Tier,
    onProgress: suspend (Long, Long?) -> Unit,
): RheaDoc = withContext(Dispatchers.IO) {
    require(uri.scheme == "content")
    val resolver = context.contentResolver
    val metadata = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
        ?.use { cursor ->
            if (!cursor.moveToFirst()) return@use null
            val name = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let(cursor::getString)
            val reportedSize = cursor.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !cursor.isNull(it) }
                ?.let(cursor::getLong)?.takeIf { it >= 0 }
            Pair(name, reportedSize)
        }
    val name = cleanDocumentName(metadata?.first ?: "arquivo")
    val declared = metadata?.second
    require(declared == null || declared <= CandidateCap)
    val sourceRoot = context.rheaDirectory(account)
    val existing = sourceRoot.walkTopDown().filter { it.isFile }.sumOf(File::length)
    val available = minOf(CandidateCap, LocalBudget - existing)
    require(available >= 0 && (declared == null || declared <= available))
    val mime = resolver.getType(uri)?.takeIf { it.matches(Regex("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+")) } ?: "application/octet-stream"
    val entry = File(sourceRoot, UUID.randomUUID().toString())
    check(entry.mkdir())
    val target = File(entry, name)
    try {
        val input = resolver.openInputStream(uri) ?: throw IOException("Document access lost")
        val total = input.use { source ->
            target.outputStream().use { output ->
                val data = ByteArray(64 * 1024)
                var copied = 0L
                var reported = -1L
                while (true) {
                    val count = source.read(data)
                    if (count == -1) break
                    copied += count
                    require(copied <= available)
                    output.write(data, 0, count)
                    if (copied / (256 * 1024) != reported) {
                        reported = copied / (256 * 1024)
                        onProgress(copied, declared)
                    }
                }
                copied
            }
        }
        require(declared == null || declared == total)
        RheaDoc(name, mime, total, tier, "Na demonstração local", target)
    } catch (error: Exception) {
        entry.deleteRecursively()
        throw error
    }
}

internal suspend fun saveDocument(context: Context, file: File, destination: Uri) = withContext(Dispatchers.IO) {
    val out = context.contentResolver.openOutputStream(destination, "wt") ?: throw IOException("Destination unavailable")
    out.use { target -> file.inputStream().use { it.copyTo(target, 64 * 1024) } }
}

internal fun handoff(context: Context, file: RheaDoc, share: Boolean) {
    val source = file.backing ?: return
    val uri = FileProvider.getUriForFile(context, context.packageName + ".files", source)
    val intent = Intent(if (share) Intent.ACTION_SEND else Intent.ACTION_VIEW).apply {
        if (share) {
            type = file.mime
            putExtra(Intent.EXTRA_STREAM, uri)
        } else setDataAndType(uri, file.mime)
        clipData = ClipData.newRawUri(file.name, uri)
        flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
    }
    context.startActivity(Intent.createChooser(intent, if (share) "Compartilhar arquivo" else "Abrir com…"))
}
