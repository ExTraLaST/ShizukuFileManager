package com.shizuku.filemanager.fs

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.media.MediaMetadataRetriever
import android.util.LruCache
import com.shizuku.filemanager.model.FileKind
import com.shizuku.filemanager.model.LinkServerConfig
import com.shizuku.filemanager.model.detectFileKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 缩略图与图标异步加载器（带内存 LruCache）
 * 支持：本机图片缩略图、视频预览帧、音乐专辑封面、APK 图标、互联远程缩略图 (/api/thumbnail)。
 */
object ThumbnailLoader {
    private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }

    suspend fun loadLocal(context: Context, path: String, sizePx: Int = 200): Bitmap? =
        withContext(Dispatchers.IO) {
            val key = "local|$path|$sizePx"
            cache.get(key)?.let { return@withContext it }
            loadLocalBitmapSync(context, path, sizePx)?.also { cache.put(key, it) }
        }

    suspend fun loadRemote(device: LinkServerConfig, wirePath: String, sizePx: Int = 256): Bitmap? =
        withContext(Dispatchers.IO) {
            val key = "remote|${device.host}:${device.port}|$wirePath|$sizePx"
            cache.get(key)?.let { return@withContext it }
            val bytes = LinkClient(device).thumbnail(wirePath, sizePx) ?: return@withContext null
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.also { cache.put(key, it) }
        }

    fun loadLocalBitmapSync(context: Context, path: String, sizePx: Int = 256): Bitmap? {
        val file = File(path)
        if (!file.isFile) return null
        return when (detectFileKind(file.name)) {
            FileKind.IMAGE -> decodeSampledImage(path, sizePx)
            FileKind.VIDEO -> extractVideoFrame(path, sizePx)
            FileKind.AUDIO -> extractAudioCover(path, sizePx)
            FileKind.APK -> loadApkIcon(context, path, sizePx)
            else -> null
        }
    }

    private fun decodeSampledImage(path: String, reqSize: Int): Bitmap? = runCatching {
        val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, opts)
        var sample = 1
        while (opts.outWidth / sample > reqSize * 2 || opts.outHeight / sample > reqSize * 2) {
            sample *= 2
        }
        BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
    }.getOrNull()

    private fun extractVideoFrame(path: String, reqSize: Int): Bitmap? = runCatching {
        val mmr = MediaMetadataRetriever()
        try {
            mmr.setDataSource(path)
            val frame = mmr.getFrameAtTime(1_000_000L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                ?: mmr.frameAtTime
            frame?.let { scaleDown(it, reqSize) }
        } finally {
            runCatching { mmr.release() }
        }
    }.getOrNull()

    private fun extractAudioCover(path: String, reqSize: Int): Bitmap? = runCatching {
        val mmr = MediaMetadataRetriever()
        try {
            mmr.setDataSource(path)
            val art = mmr.embeddedPicture ?: return@runCatching null
            BitmapFactory.decodeByteArray(art, 0, art.size)?.let { scaleDown(it, reqSize) }
        } finally {
            runCatching { mmr.release() }
        }
    }.getOrNull()

    private fun loadApkIcon(context: Context, path: String, reqSize: Int): Bitmap? = runCatching {
        val pm = context.packageManager
        @Suppress("DEPRECATION")
        val info = pm.getPackageArchiveInfo(path, PackageManager.GET_ACTIVITIES) ?: return@runCatching null
        val appInfo = info.applicationInfo ?: return@runCatching null
        appInfo.sourceDir = path
        appInfo.publicSourceDir = path
        val drawable = appInfo.loadIcon(pm)
        val bmp = Bitmap.createBitmap(reqSize, reqSize, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        drawable.setBounds(0, 0, reqSize, reqSize)
        drawable.draw(canvas)
        bmp
    }.getOrNull()

    private fun scaleDown(src: Bitmap, maxEdge: Int): Bitmap {
        val max = maxOf(src.width, src.height)
        if (max <= maxEdge) return src
        val ratio = maxEdge.toFloat() / max.toFloat()
        return Bitmap.createScaledBitmap(
            src,
            maxOf(1, (src.width * ratio).toInt()),
            maxOf(1, (src.height * ratio).toInt()),
            true
        )
    }
}
