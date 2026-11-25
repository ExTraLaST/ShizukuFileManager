package com.shizuku.filemanager.fs

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaController
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.MoreExecutors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

data class AudioNowPlaying(
    val title: String = "",
    val uri: String = "",
    val isPlaying: Boolean = false,
    val positionMs: Long = 0L,
    val durationMs: Long = 0L
)

/**
 * 后台音乐播放服务（Media3 MediaSessionService）
 * 自动接管系统媒体通知栏控制（播放/暂停/切歌/进度条）与后台锁屏保活。
 */
class PlaybackService : MediaSessionService() {
    private var mediaSession: MediaSession? = null
    private var player: ExoPlayer? = null

    override fun onCreate() {
        super.onCreate()
        val exo = ExoPlayer.Builder(this).build().also { player = it }
        mediaSession = MediaSession.Builder(this, exo).build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = mediaSession

    override fun onDestroy() {
        mediaSession?.run {
            player.release()
            release()
        }
        mediaSession = null
        player = null
        super.onDestroy()
    }
}

/**
 * 全局音乐播放控制器（驱动底部迷你播放条与音乐播放界面，对接 PlaybackService）
 */
object AudioPlaybackController {
    private val _state = MutableStateFlow(AudioNowPlaying())
    val state: StateFlow<AudioNowPlaying> = _state

    private var controller: MediaController? = null

    fun connect(context: Context) {
        if (controller != null) return
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        future.addListener(
            {
                runCatching {
                    val ctrl = future.get()
                    controller = ctrl
                    ctrl.addListener(object : Player.Listener {
                        override fun onIsPlayingChanged(isPlaying: Boolean) {
                            syncState()
                        }

                        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                            syncState()
                        }
                    })
                    syncState()
                }
            },
            MoreExecutors.directExecutor()
        )
    }

    fun playUri(context: Context, title: String, uri: Uri) {
        connect(context)
        val item = MediaItem.Builder()
            .setUri(uri)
            .setMediaMetadata(MediaMetadata.Builder().setTitle(title).build())
            .build()
        controller?.apply {
            setMediaItem(item)
            prepare()
            play()
        }
        _state.value = AudioNowPlaying(title = title, uri = uri.toString(), isPlaying = true)
    }

    fun togglePlayPause() {
        val c = controller ?: return
        if (c.isPlaying) c.pause() else c.play()
        syncState()
    }

    fun seekTo(ms: Long) {
        controller?.seekTo(ms)
        syncState()
    }

    fun stop() {
        controller?.stop()
        _state.value = AudioNowPlaying()
    }

    fun syncState() {
        val c = controller ?: return
        val title = c.currentMediaItem?.mediaMetadata?.title?.toString() ?: _state.value.title
        _state.value = AudioNowPlaying(
            title = title,
            uri = c.currentMediaItem?.localConfiguration?.uri?.toString() ?: "",
            isPlaying = c.isPlaying,
            positionMs = c.currentPosition.coerceAtLeast(0L),
            durationMs = c.duration.coerceAtLeast(0L)
        )
    }

    /** 构造带 X-Shizuku-Token 的 ExoPlayer 实例（用于视频页直播互联远程媒体） */
    @OptIn(UnstableApi::class)
    fun buildAuthorizedPlayer(context: Context, headers: Map<String, String>): ExoPlayer {
        val httpFactory = DefaultHttpDataSource.Factory()
            .setDefaultRequestProperties(headers)
            .setAllowCrossProtocolRedirects(true)
        return ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(httpFactory))
            .build()
    }
}
