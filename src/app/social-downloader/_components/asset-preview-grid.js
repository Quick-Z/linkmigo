"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { apiUrl, formatBytes } from "../_lib/format";
import { logClientAction } from "../_lib/user-action-log";

const fallbackTheme = {
  accent: "#6b7280",
  accentText: "#374151",
  border: "rgba(148, 163, 184, 0.34)",
  ring: "rgba(148, 163, 184, 0.18)",
  buttonText: "#334155",
  bodyText: "#122033",
  mutedText: "#6c7a8f",
  subtleText: "#708199",
  colorMode: "light",
  buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.92) 0%, rgba(241,245,249,0.9) 100%)",
  buttonShadow: "0 18px 34px rgba(148, 163, 184, 0.14)",
  selectedShadow: "0 18px 34px rgba(148, 163, 184, 0.14)",
  previewGradient: "linear-gradient(135deg, #eef2ff 0%, #f8fafc 100%)",
  cardBackground: "rgba(255,255,255,0.72)",
  cardGradient: "linear-gradient(135deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.66) 100%)",
  cardBorder: "rgba(255,255,255,0.68)",
  cardShadow: "0 18px 36px rgba(132, 158, 192, 0.12), inset 0 1px 0 rgba(255,255,255,0.76)",
  chipBorder: "rgba(255,255,255,0.7)",
  glassGradientSoft: "linear-gradient(135deg, rgba(255,255,255,0.88) 0%, rgba(255,255,255,0.58) 100%)",
  iconBackground: "rgba(255,255,255,0.85)",
  mediaOverlay: "rgba(8,17,31,0.1)",
  modalHeaderBackground: "rgba(255,255,255,0.24)",
  modalPanelBackground: "rgba(255,255,255,0.28)",
  modalButtonBackground: "rgba(255,255,255,0.52)",
  modalButtonText: "#142033",
  panelBorder: "rgba(255,255,255,0.72)",
  previewBackdropOverlay: "radial-gradient(circle at center, rgba(255,255,255,0.34), rgba(15,23,42,0.42) 72%)",
  previewBackdropVeil: "linear-gradient(135deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.08) 48%, rgba(9,18,32,0.34) 100%)",
  selectionBackground: "rgba(255,255,255,0.76)",
  toolbarBackground: "rgba(255,255,255,0.42)",
  toolbarText: "#122033",
};
const themeTransition = "background-color 520ms cubic-bezier(0.22,1,0.36,1), border-color 520ms cubic-bezier(0.22,1,0.36,1), box-shadow 520ms cubic-bezier(0.22,1,0.36,1), color 520ms cubic-bezier(0.22,1,0.36,1), transform 180ms ease";
const labelsByLanguage = {
  zh: {
    audio: "音频",
    closePreview: "关闭预览",
    download: "下载",
    fullscreen: "全屏播放",
    image: "图片",
    next: "下一张",
    pauseVideo: "暂停视频",
    playVideo: "播放视频",
    previous: "上一张",
    progress: "播放进度",
    video: "视频",
    volume: "音量",
  },
  en: {
    audio: "Audio",
    closePreview: "Close preview",
    download: "Download",
    fullscreen: "Fullscreen",
    image: "Image",
    next: "Next",
    pauseVideo: "Pause video",
    playVideo: "Play video",
    previous: "Previous",
    progress: "Playback progress",
    video: "Video",
    volume: "Volume",
  },
};

export function AssetPreviewGrid({
  assets,
  labels = {},
  language = "zh",
  onToggleAsset,
  selectedAssetIds = [],
  theme = fallbackTheme,
}) {
  const copy = { ...(labelsByLanguage[language] ?? labelsByLanguage.zh), ...labels };
  const [isMounted, setIsMounted] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(null);
  const previewAsset = previewIndex == null ? null : assets[previewIndex] ?? null;
  const hasMultipleAssets = assets.length > 1;

  useEffect(() => {
    setIsMounted(true);
  }, []);

  function openPreview(index) {
    const asset = assets[index];

    if (!asset) {
      return;
    }

    logClientAction("asset_preview_clicked", {
      asset_id: asset.id,
      filename: asset.filename,
      media_type: asset.media_type,
      preview_url: asset.preview_url,
    });

    setPreviewIndex(index);
  }

  function showPrevious() {
    setPreviewIndex((current) => {
      if (current == null || assets.length === 0) {
        return current;
      }

      return (current - 1 + assets.length) % assets.length;
    });
  }

  function showNext() {
    setPreviewIndex((current) => {
      if (current == null || assets.length === 0) {
        return current;
      }

      return (current + 1) % assets.length;
    });
  }

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(9.75rem,1fr))] gap-2.5 pb-1 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]">
        {assets.map((asset, index) => {
          const previewUrl = apiUrl(asset.preview_url);
          const isSelected = selectedAssetIds.includes(asset.id);
          const mediaLabel = asset.media_type === "video"
            ? copy.video
            : asset.media_type === "audio"
              ? copy.audio
              : copy.image;

          return (
            <article
              aria-pressed={isSelected}
              className="group grid min-w-0 cursor-pointer content-start gap-2 rounded-[1.15rem] border p-2.5 backdrop-blur-xl transition duration-300"
              key={asset.id}
              onClick={() => onToggleAsset(asset.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onToggleAsset(asset.id);
                }
              }}
              role="button"
              style={buildAssetCardStyle(theme, isSelected)}
              tabIndex={0}
            >
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="grid size-8 shrink-0 place-items-center rounded-full border text-[11px] font-black"
                    style={{
                      backgroundColor: theme.iconBackground,
                      borderColor: theme.panelBorder,
                      color: theme.accentText,
                      boxShadow: theme.colorMode === "dark" ? "inset 0 1px 0 rgba(255,255,255,0.08)" : "inset 0 1px 0 rgba(255,255,255,0.85)",
                    }}
                  >
                    <MediaTypeIcon type={asset.media_type} />
                  </span>
                  <div className="grid min-w-0 gap-0.5">
                    <span className="truncate text-xs font-semibold sm:text-sm" style={{ color: theme.bodyText }} title={asset.filename}>
                      {asset.filename}
                    </span>
                    <span className="text-[11px] font-medium" style={{ color: theme.mutedText }}>{mediaLabel}</span>
                  </div>
                </div>

                <span
                  aria-hidden="true"
                  className="grid size-4 shrink-0 place-items-center rounded-full border text-[9px] font-bold transition"
                  style={buildSelectionBadgeStyle(theme, isSelected)}
                >
                  {isSelected ? "✓" : ""}
                </span>
              </div>

              <div
                className={`relative aspect-[4/3.15] overflow-hidden rounded-[0.9rem] border ${
                  asset.media_type === "audio" ? "cursor-pointer" : "cursor-zoom-in"
                }`}
                onClick={(event) => {
                  event.stopPropagation();
                  openPreview(index);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    openPreview(index);
                  }
                }}
                role="button"
                style={{
                  backgroundColor: theme.colorMode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.4)",
                  borderColor: theme.panelBorder,
                  boxShadow: theme.colorMode === "dark" ? "inset 0 1px 0 rgba(255,255,255,0.08)" : "inset 0 1px 0 rgba(255,255,255,0.65)",
                }}
                tabIndex={0}
              >
                {asset.media_type === "video" ? (
                  <>
                    <video
                      className="h-full w-full object-cover"
                      muted
                      playsInline
                      preload="metadata"
                      src={previewUrl}
                    />
                    <span
                      className="pointer-events-none absolute inset-0 grid place-items-center"
                      style={{ backgroundColor: theme.mediaOverlay }}
                    >
                      <span
                        className="grid size-10 place-items-center rounded-full border shadow-[0_12px_24px_rgba(15,23,42,0.16)] backdrop-blur-xl"
                        style={{
                          backgroundColor: theme.modalButtonBackground,
                          borderColor: theme.panelBorder,
                          color: theme.accentText,
                        }}
                      >
                        <PlayIcon />
                      </span>
                    </span>
                  </>
                ) : asset.media_type === "audio" ? (
                  <div
                    className="flex h-full w-full flex-col items-center justify-center gap-4 p-4"
                    style={{ backgroundImage: theme.previewGradient }}
                  >
                    <span
                      className="grid size-16 place-items-center rounded-[1.25rem] border text-3xl shadow-[0_14px_28px_rgba(120,150,190,0.12)]"
                      style={{
                        backgroundColor: theme.iconBackground,
                        borderColor: theme.panelBorder,
                        color: theme.accentText,
                      }}
                    >
                      ♪
                    </span>
                    <span className="text-xs font-semibold" style={{ color: theme.mutedText }}>{copy.audio}</span>
                  </div>
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    alt={asset.filename}
                    className="h-full w-full object-cover"
                    draggable={false}
                    loading="lazy"
                    src={previewUrl}
                  />
                )}
              </div>

              <div className="flex flex-wrap gap-1.5 text-[10px] font-semibold sm:text-[11px]" style={{ color: theme.mutedText }}>
                <span>{formatBytes(asset.size_bytes)}</span>
                {asset.width && asset.height ? <span>{`${asset.width} x ${asset.height}`}</span> : null}
              </div>

              <a
                aria-label={`${copy.download} ${asset.filename}`}
                className="lm-themed-action inline-flex h-8 w-full cursor-pointer items-center justify-center rounded-full border px-3 text-xs font-semibold transition"
                href={apiUrl(asset.download_url)}
                onClick={(event) => {
                  event.stopPropagation();
                  logClientAction("asset_download_clicked", {
                    asset_id: asset.id,
                    filename: asset.filename,
                    media_type: asset.media_type,
                    size_bytes: asset.size_bytes,
                    download_url: asset.download_url,
                  });
                }}
                style={buildActionButtonStyle(theme)}
              >
                {copy.download}
              </a>
            </article>
          );
        })}
      </div>

      {isMounted && previewAsset
        ? createPortal(
            <PreviewModal
              asset={previewAsset}
              hasMultipleAssets={hasMultipleAssets}
              labels={copy}
              onClose={() => setPreviewIndex(null)}
              onNext={showNext}
              onPrevious={showPrevious}
              theme={theme}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function PreviewModal({ asset, hasMultipleAssets, labels, onClose, onNext, onPrevious, theme }) {
  const previewUrl = apiUrl(asset.preview_url);
  const downloadUrl = apiUrl(asset.download_url);

  return (
    <div
      aria-label={labels.image}
      aria-modal="true"
      className="fixed inset-0 z-[100] grid place-items-center overflow-hidden p-3 sm:p-5"
      onClick={onClose}
      role="dialog"
    >
      <PreviewBackdrop asset={asset} previewUrl={previewUrl} theme={theme} />

      <div
        className="relative z-10 flex h-[calc(100svh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-7xl flex-col overflow-hidden rounded-[1.75rem] border shadow-[0_34px_90px_rgba(4,15,32,0.34)] backdrop-blur-[34px] sm:h-[calc(100svh-2.5rem)] sm:w-[calc(100vw-2.5rem)]"
        onClick={(event) => event.stopPropagation()}
        style={{
          backgroundColor: theme.modalPanelBackground,
          borderColor: theme.colorMode === "dark" ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.38)",
        }}
      >
        <div
          className="flex shrink-0 items-center gap-2 border-b px-3 py-3 backdrop-blur-[26px] sm:px-4"
          style={{
            backgroundColor: theme.modalHeaderBackground,
            borderColor: theme.colorMode === "dark" ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.28)",
          }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="grid size-9 shrink-0 place-items-center rounded-full border"
              style={{
                backgroundColor: theme.iconBackground,
                borderColor: theme.panelBorder,
                color: theme.accentText,
              }}
            >
              <MediaTypeIcon type={asset.media_type} />
            </span>
            <p className="min-w-0 truncate text-sm font-semibold text-white drop-shadow-[0_1px_8px_rgba(0,0,0,0.32)]">
              {asset.filename}
            </p>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <a
              className="inline-flex h-10 cursor-pointer items-center justify-center rounded-full border px-4 text-sm font-semibold shadow-[0_12px_28px_rgba(4,15,32,0.18)] backdrop-blur-xl transition"
              href={downloadUrl}
              onClick={() => {
                logClientAction("preview_asset_download_clicked", {
                  asset_id: asset.id,
                  filename: asset.filename,
                  media_type: asset.media_type,
                  download_url: asset.download_url,
                });
              }}
              style={buildModalButtonStyle(theme)}
            >
              {labels.download}
            </a>
            <button
              aria-label={labels.closePreview}
              className="grid size-10 cursor-pointer place-items-center rounded-full border text-xl leading-none shadow-[0_12px_28px_rgba(4,15,32,0.18)] backdrop-blur-xl transition"
              onClick={onClose}
              style={buildModalButtonStyle(theme)}
              type="button"
            >
              ×
            </button>
          </div>
        </div>

        <div className="relative grid min-h-0 flex-1 place-items-center p-3 sm:p-5">
          {hasMultipleAssets ? (
            <>
              <button
                className="absolute left-3 top-1/2 z-20 hidden h-12 -translate-y-1/2 cursor-pointer items-center rounded-full border border-white/45 bg-white/48 px-4 text-sm font-semibold text-[#142033] shadow-[0_14px_34px_rgba(4,15,32,0.2)] backdrop-blur-xl transition sm:inline-flex"
                onClick={onPrevious}
                style={buildModalButtonStyle(theme)}
                type="button"
              >
                {labels.previous}
              </button>
              <button
                className="absolute right-3 top-1/2 z-20 hidden h-12 -translate-y-1/2 cursor-pointer items-center rounded-full border border-white/45 bg-white/48 px-4 text-sm font-semibold text-[#142033] shadow-[0_14px_34px_rgba(4,15,32,0.2)] backdrop-blur-xl transition sm:inline-flex"
                onClick={onNext}
                style={buildModalButtonStyle(theme)}
                type="button"
              >
                {labels.next}
              </button>
              <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 gap-2 sm:hidden">
                <button
                  className="h-10 cursor-pointer rounded-full border border-white/45 bg-white/54 px-4 text-sm font-semibold text-[#142033] backdrop-blur-xl"
                  onClick={onPrevious}
                  style={buildModalButtonStyle(theme)}
                  type="button"
                >
                  {labels.previous}
                </button>
                <button
                  className="h-10 cursor-pointer rounded-full border border-white/45 bg-white/54 px-4 text-sm font-semibold text-[#142033] backdrop-blur-xl"
                  onClick={onNext}
                  style={buildModalButtonStyle(theme)}
                  type="button"
                >
                  {labels.next}
                </button>
              </div>
            </>
          ) : null}

          {asset.media_type === "video" ? (
            <VideoPreview labels={labels} previewUrl={previewUrl} theme={theme} />
          ) : asset.media_type === "audio" ? (
            <div
              className="grid w-full max-w-xl gap-5 rounded-[1.5rem] border p-6 text-center backdrop-blur-2xl"
              style={{
                backgroundColor: theme.cardBackground,
                borderColor: theme.panelBorder,
              }}
            >
              <span
                className="mx-auto grid size-20 place-items-center rounded-[1.5rem] border text-4xl"
                style={{
                  backgroundColor: theme.iconBackground,
                  borderColor: theme.panelBorder,
                  color: theme.modalButtonText,
                }}
              >
                ♪
              </span>
              <audio className="w-full" controls preload="metadata" src={previewUrl} />
            </div>
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              alt={asset.filename}
              className="block max-h-[calc(100svh-8rem)] max-w-[calc(100vw-2rem)] rounded-[1.25rem] object-contain shadow-[0_24px_70px_rgba(4,15,32,0.28)] sm:max-h-[calc(100svh-9rem)] sm:max-w-[calc(100vw-4rem)]"
              draggable={false}
              src={previewUrl}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function VideoPreview({ labels, previewUrl, theme }) {
  const frameRef = useRef(null);
  const videoRef = useRef(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);

  function syncTime() {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    setCurrentTime(Number.isFinite(video.currentTime) ? video.currentTime : 0);
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
  }

  async function togglePlayback() {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (video.paused) {
      try {
        await video.play();
      } catch {
        setIsPlaying(false);
      }
      return;
    }

    video.pause();
  }

  function seek(event) {
    const video = videoRef.current;
    const nextTime = Number(event.target.value);

    if (!video || !Number.isFinite(nextTime)) {
      return;
    }

    video.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  function changeVolume(event) {
    const video = videoRef.current;
    const nextVolume = Number(event.target.value);

    if (!video || !Number.isFinite(nextVolume)) {
      return;
    }

    video.volume = nextVolume;
    video.muted = nextVolume === 0;
    setVolume(nextVolume);
  }

  async function toggleFullscreen() {
    const frame = frameRef.current;

    if (!frame) {
      return;
    }

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen?.();
        return;
      }

      await frame.requestFullscreen?.();
    } catch {
      // Fullscreen can be denied by the browser; leave playback uninterrupted.
    }
  }

  return (
    <div
      className="group relative flex max-h-[calc(100svh-8rem)] max-w-[calc(100vw-2rem)] items-center justify-center overflow-hidden rounded-[1.25rem] bg-black/25 shadow-[0_24px_70px_rgba(4,15,32,0.28)] sm:max-h-[calc(100svh-9rem)] sm:max-w-[calc(100vw-4rem)]"
      ref={frameRef}
    >
      <video
        className="block max-h-[calc(100svh-8rem)] max-w-[calc(100vw-2rem)] object-contain sm:max-h-[calc(100svh-9rem)] sm:max-w-[calc(100vw-4rem)]"
        onClick={togglePlayback}
        onDurationChange={syncTime}
        onLoadedMetadata={syncTime}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onTimeUpdate={syncTime}
        playsInline
        preload="metadata"
        ref={videoRef}
        src={previewUrl}
      />

      <div className="pointer-events-none absolute inset-x-2 bottom-2 translate-y-3 opacity-0 transition-all duration-300 ease-out group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100 sm:inset-x-3 sm:bottom-3">
        <div
          className="pointer-events-auto flex w-full min-w-0 flex-nowrap items-center gap-2 rounded-[1.15rem] border px-2.5 py-2 shadow-[0_18px_42px_rgba(4,15,32,0.2)] backdrop-blur-2xl sm:px-3"
          style={{
            backgroundColor: theme.toolbarBackground,
            borderColor: theme.panelBorder,
            boxShadow: `0 18px 42px ${hexToRgba(theme.accent, 0.16)}`,
            color: theme.toolbarText,
          }}
        >
          <button
            aria-label={isPlaying ? labels.pauseVideo : labels.playVideo}
            className="grid size-9 cursor-pointer place-items-center rounded-full border transition"
            onClick={togglePlayback}
            style={buildModalButtonStyle(theme)}
            type="button"
          >
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>

          <input
            aria-label={labels.progress}
            className="min-w-0 flex-1 cursor-pointer accent-current"
            max={duration || 1}
            min="0"
            onChange={seek}
            step="0.1"
            style={{ color: theme.accentText, accentColor: theme.accent }}
            type="range"
            value={Math.min(currentTime, duration || 1)}
          />

          <span className="hidden shrink-0 text-xs font-semibold tabular-nums min-[420px]:inline" style={{ color: theme.toolbarText }}>
            {formatMediaTime(duration)}
          </span>

          <label className="flex min-w-0 shrink-0 items-center gap-1">
            <span className="sr-only">{labels.volume}</span>
            <VolumeIcon />
            <input
              aria-label={labels.volume}
              className="w-12 cursor-pointer accent-current sm:w-14"
              max="1"
              min="0"
              onChange={changeVolume}
              step="0.05"
              style={{ color: theme.accentText, accentColor: theme.accent }}
              type="range"
              value={volume}
            />
          </label>

          <button
            aria-label={labels.fullscreen}
            className="grid size-9 cursor-pointer place-items-center rounded-full border transition"
            onClick={toggleFullscreen}
            style={buildModalButtonStyle(theme)}
            type="button"
          >
            <FullscreenIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewBackdrop({ asset, previewUrl, theme }) {
  return (
    <div className="absolute inset-0 overflow-hidden">
      {asset.media_type === "video" ? (
        <video
          className="absolute inset-0 h-full w-full scale-110 object-cover opacity-55 blur-[46px]"
          autoPlay
          loop
          muted
          playsInline
          src={previewUrl}
        />
      ) : asset.media_type === "image" ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          alt=""
          className="absolute inset-0 h-full w-full scale-110 object-cover opacity-62 blur-[48px]"
          src={previewUrl}
        />
      ) : (
        <div className="absolute inset-0" style={{ backgroundImage: theme.previewGradient }} />
      )}
      <div className="absolute inset-0 backdrop-blur-[18px]" style={{ background: theme.previewBackdropOverlay }} />
      <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${hexToRgba(theme.accent, 0.18)} 0%, transparent 34%), ${theme.previewBackdropVeil}` }} />
    </div>
  );
}

function MediaTypeIcon({ type }) {
  if (type === "video") {
    return <VideoIcon />;
  }

  if (type === "audio") {
    return <AudioIcon />;
  }

  return <ImageIcon />;
}

function ImageIcon() {
  return (
    <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
      <rect height="15" rx="3" stroke="currentColor" strokeWidth="2" width="18" x="3" y="5" />
      <path d="M7 16l3.2-3.2a1.2 1.2 0 011.7 0L15 16l1.2-1.2a1.2 1.2 0 011.7 0L21 18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <circle cx="8.5" cy="9.5" fill="currentColor" r="1.2" />
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
      <rect height="14" rx="3" stroke="currentColor" strokeWidth="2" width="16" x="3" y="5" />
      <path d="M16 10.5l4-2.4v7.8l-4-2.4v-3z" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
      <path d="M8.5 9.2v5.6l4.4-2.8-4.4-2.8z" fill="currentColor" />
    </svg>
  );
}

function AudioIcon() {
  return (
    <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
      <path d="M10 18V6l8-2v12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <circle cx="7" cy="18" r="3" stroke="currentColor" strokeWidth="2" />
      <circle cx="15" cy="16" r="3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24">
      <path d="M8.5 5.8v12.4L18 12 8.5 5.8z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24">
      <path d="M8 6.5h3v11H8v-11zm5 0h3v11h-3v-11z" fill="currentColor" />
    </svg>
  );
}

function VolumeIcon() {
  return (
    <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
      <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
      <path d="M15.5 9a4.5 4.5 0 010 6" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
      <path d="M18 6.5a8 8 0 010 11" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24">
      <path d="M8.5 4.5H5.5a1 1 0 00-1 1v3m11-4h3a1 1 0 011 1v3m-15 7v3a1 1 0 001 1h3m11-4v3a1 1 0 01-1 1h-3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function formatMediaTime(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0:00";
  }

  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60).toString().padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function buildAssetCardStyle(theme, isSelected) {
  return {
    backgroundColor: isSelected ? hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.14 : 0.08) : theme.cardBackground,
    backgroundImage: theme.cardGradient,
    borderColor: isSelected ? theme.border : theme.cardBorder,
    boxShadow: isSelected
      ? theme.selectedShadow
      : theme.cardShadow,
    transition: themeTransition,
  };
}

function buildSelectionBadgeStyle(theme, isSelected) {
  return {
    color: isSelected ? theme.buttonText : "transparent",
    backgroundColor: isSelected ? hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.2 : 0.12) : theme.selectionBackground,
    backgroundImage: isSelected
      ? theme.glassGradientSoft
      : "none",
    borderColor: isSelected ? theme.border : theme.panelBorder,
    boxShadow: isSelected ? theme.buttonShadow : "none",
    transition: themeTransition,
  };
}

function buildActionButtonStyle(theme) {
  return {
    color: theme.buttonText,
    backgroundColor: hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.18 : 0.12),
    backgroundImage: theme.glassGradientSoft,
    borderColor: theme.border,
    boxShadow: theme.buttonShadow,
    transition: themeTransition,
    ...buildActionInteractionVars(theme),
  };
}

function buildModalButtonStyle(theme) {
  return {
    backgroundColor: theme.modalButtonBackground,
    backgroundImage: theme.glassGradientSoft,
    borderColor: theme.colorMode === "dark" ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.45)",
    boxShadow: `0 12px 28px ${hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.2 : 0.12)}`,
    color: theme.modalButtonText,
  };
}

function buildActionInteractionVars(theme) {
  return {
    "--lm-action-hover-bg": hexToRgba(theme.accent, 0.18),
    "--lm-action-hover-border": theme.borderStrong ?? theme.border,
    "--lm-action-hover-shadow": theme.buttonShadow,
    "--lm-action-active-bg": hexToRgba(theme.accent, 0.24),
    "--lm-action-active-shadow": `0 8px 18px ${hexToRgba(theme.accent, 0.18)}`,
  };
}

function hexToRgba(hex, alpha) {
  const normalized = hex.replace("#", "");
  const safe = normalized.length === 3
    ? normalized.split("").map((char) => char + char).join("")
    : normalized;
  const bigint = Number.parseInt(safe, 16);
  const red = (bigint >> 16) & 255;
  const green = (bigint >> 8) & 255;
  const blue = bigint & 255;

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
