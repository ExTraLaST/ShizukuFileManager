package com.shizuku.filemanager.ui

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.annotation.OptIn
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.ui.PlayerView
import com.shizuku.filemanager.MediaOpenRequest
import com.shizuku.filemanager.fs.AudioPlaybackController
import com.shizuku.filemanager.fs.LinkClient
import com.shizuku.filemanager.fs.SmbDataSource
import com.shizuku.filemanager.fs.SmbFileSystem
import com.shizuku.filemanager.model.PaneRoot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 全屏图片缩放查看器与 Media3 视频播放器（支持本机 / SMB 流播 / 互联 Range 流播）
 */
@OptIn(UnstableApi::class)
@Composable
fun MediaViewerOverlay(request: MediaOpenRequest, onClose: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        when (request) {
            is MediaOpenRequest.Image -> ImageViewerContent(request)
            is MediaOpenRequest.Video -> VideoPlayerContent(request)
        }
        IconButton(
            onClick = onClose,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(12.dp)
        ) {
            Icon(Icons.Default.Close, contentDescription = "关闭", tint = Color.White)
        }
        Text(
            text = request.let { if (it is MediaOpenRequest.Image) it.title else (it as MediaOpenRequest.Video).title },
            color = Color.White,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(16.dp)
                .fillMaxWidth(0.75f)
        )
    }
}

@Composable
private fun ImageViewerContent(req: MediaOpenRequest.Image) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var offsetY by remember { mutableFloatStateOf(0f) }
    var bitmap by remember(req.path) { mutableStateOf<android.graphics.Bitmap?>(null) }

    LaunchedEffect(req.path) {
        bitmap = withContext(Dispatchers.IO) {
            runCatching {
                when (val r = req.root) {
                    PaneRoot.Local -> BitmapFactory.decodeFile(req.path)
                    is PaneRoot.Link -> LinkClient(r.device).openDownloadStream(req.path).use { BitmapFactory.decodeStream(it) }
                    is PaneRoot.Smb -> SmbFileSystem(r.server, r.share).openInput(req.path).use { BitmapFactory.decodeStream(it) }
                }
            }.getOrNull()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 5f)
                    if (scale > 1f) {
                        offsetX += pan.x
                        offsetY += pan.y
                    } else {
                        offsetX = 0f
                        offsetY = 0f
                    }
                }
            },
        contentAlignment = Alignment.Center
    ) {
        val bmp = bitmap
        if (bmp != null) {
            Image(
                bitmap = bmp.asImageBitmap(),
                contentDescription = req.title,
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offsetX, translationY = offsetY)
            )
        } else {
            CircularProgressIndicator(color = Color.White)
        }
    }
}

@OptIn(UnstableApi::class)
@Composable
private fun VideoPlayerContent(req: MediaOpenRequest.Video) {
    val context = LocalContext.current
    val player = remember(req.path) {
        when (val r = req.root) {
            PaneRoot.Local -> ExoPlayer.Builder(context).build().apply {
                setMediaItem(MediaItem.fromUri(Uri.fromFile(File(req.path))))
                prepare()
                playWhenReady = true
            }
            is PaneRoot.Link -> {
                val client = LinkClient(r.device)
                AudioPlaybackController.buildAuthorizedPlayer(context, client.authHeaders()).apply {
                    setMediaItem(MediaItem.fromUri(Uri.parse(client.downloadUrl(req.path))))
                    prepare()
                    playWhenReady = true
                }
            }
            is PaneRoot.Smb -> {
                val clean = req.path.trimStart('/')
                val share = r.share ?: clean.substringBefore('/')
                val rel = if (r.share != null) clean else clean.substringAfter('/', "")
                val factory = SmbDataSource.Factory(r.server, share, rel)
                ExoPlayer.Builder(context).build().apply {
                    val src = ProgressiveMediaSource.Factory(factory)
                        .createMediaSource(MediaItem.fromUri(Uri.parse("smb://${r.server.host}/$share/$rel")))
                    setMediaSource(src)
                    prepare()
                    playWhenReady = true
                }
            }
        }
    }

    DisposableEffect(player) {
        onDispose { player.release() }
    }

    AndroidView(
        factory = { ctx -> PlayerView(ctx).apply { this.player = player } },
        modifier = Modifier.fillMaxSize()
    )
}

/**
 * 底部音乐迷你播放条（与后台 PlaybackService 实时同步）
 */
@Composable
fun MiniAudioPlayerBar(modifier: Modifier = Modifier) {
    val state by AudioPlaybackController.state.collectAsState()
    if (state.title.isBlank()) return

    Surface(
        tonalElevation = 6.dp,
        shadowElevation = 6.dp,
        modifier = modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier
                .padding(horizontal = 12.dp, vertical = 6.dp)
                .fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(Icons.Default.MusicNote, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(8.dp))
            Text(
                text = state.title,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f)
            )
            IconButton(onClick = { AudioPlaybackController.togglePlayPause() }) {
                Icon(
                    if (state.isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow,
                    contentDescription = "播放/暂停"
                )
            }
            IconButton(onClick = { AudioPlaybackController.stop() }) {
                Icon(Icons.Default.Close, contentDescription = "停止")
            }
        }
    }
}
