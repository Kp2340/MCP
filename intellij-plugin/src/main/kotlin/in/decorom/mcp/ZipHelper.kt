package `in`.decorom.mcp

import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * Pure-Kotlin zip/unzip — no external tools (no powershell, no zip binary).
 * Works on Windows, macOS, Linux, and inside Docker.
 */
object ZipHelper {

    private val SKIP_DIRS = setOf(
        "node_modules", ".git", "build", "dist", ".gradle",
        ".idea", "out", "target", ".next", ".cache", "__pycache__"
    )

    /** Zip an entire folder into a ByteArray. */
    fun zipFolder(srcPath: String): ByteArray {
        val src  = File(srcPath)
        val baos = ByteArrayOutputStream()
        ZipOutputStream(baos).use { zos ->
            src.walkTopDown()
                .filter { file ->
                    // Skip hidden dirs and common large/irrelevant directories
                    file.path.split(File.separator).none { seg -> seg in SKIP_DIRS || seg.startsWith(".") }
                }
                .forEach { file ->
                    val entry = file.relativeTo(src).path.replace(File.separatorChar, '/')
                    if (file.isDirectory) {
                        if (entry.isNotEmpty()) zos.putNextEntry(ZipEntry("$entry/"))
                    } else {
                        zos.putNextEntry(ZipEntry(entry))
                        file.inputStream().use { it.copyTo(zos) }
                        zos.closeEntry()
                    }
                }
        }
        return baos.toByteArray()
    }

    /** Unzip a ByteArray into a destination directory (safe — no path traversal). */
    fun unzipTo(zipBytes: ByteArray, destPath: String) {
        val dest = File(destPath).canonicalFile
        dest.mkdirs()
        ZipInputStream(zipBytes.inputStream()).use { zis ->
            var entry = zis.nextEntry
            while (entry != null) {
                // Safety: normalise and reject traversal
                val name   = entry.name.replace('\\', '/').trimStart('/')
                val target = File(dest, name).canonicalFile
                if (!target.path.startsWith(dest.path + File.separator) && target != dest) {
                    zis.closeEntry()
                    entry = zis.nextEntry
                    continue
                }
                if (entry.isDirectory) {
                    target.mkdirs()
                } else {
                    target.parentFile?.mkdirs()
                    target.outputStream().use { zis.copyTo(it) }
                }
                zis.closeEntry()
                entry = zis.nextEntry
            }
        }
    }
}
