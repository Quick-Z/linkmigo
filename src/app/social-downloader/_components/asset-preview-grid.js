"use client";

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
    text: "文本",
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
    text: "Text",
    video: "Video",
    volume: "Volume",
  },
};

export function AssetPreviewGrid({
  assets,
  labels = {},
  language = "zh",
  onPreviewAsset,
  onToggleAsset,
  selectedAssetIds = [],
  theme = fallbackTheme,
}) {
  const copy = { ...(labelsByLanguage[language] ?? labelsByLanguage.zh), ...labels };

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

    onPreviewAsset?.(index);
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(9.75rem,1fr))] gap-2.5 pb-1 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]">
      {assets.map((asset, index) => {
        const previewUrl = apiUrl(asset.preview_url);
        const isSelected = selectedAssetIds.includes(asset.id);
        const mediaLabel = asset.media_type === "video"
          ? copy.video
          : asset.media_type === "audio"
            ? copy.audio
            : asset.media_type === "text"
              ? copy.text
              : copy.image;

        return (
          <article
            aria-pressed={isSelected}
            className="group grid min-w-0 cursor-pointer content-start gap-2 rounded-[1.15rem] border p-2.5 outline-none backdrop-blur-xl transition duration-300 focus:outline-none focus-visible:outline-none"
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
              className={`relative aspect-[4/3.15] overflow-hidden rounded-[0.9rem] border outline-none focus:outline-none focus-visible:outline-none ${
                asset.media_type === "audio" || asset.media_type === "text" ? "cursor-pointer" : "cursor-zoom-in"
              }`}
              onClick={(event) => {
                event.stopPropagation();
                openPreview(index);
              }}
              onMouseDown={(event) => {
                event.preventDefault();
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
              ) : asset.media_type === "text" ? (
                <div
                  className="flex h-full w-full flex-col items-center justify-center gap-3 p-4 text-center"
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
                    <TextIcon />
                  </span>
                  <span className="max-w-full truncate text-xs font-semibold" style={{ color: theme.mutedText }}>{copy.text}</span>
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
  );
}

function MediaTypeIcon({ type }) {
  if (type === "video") {
    return <VideoIcon />;
  }

  if (type === "audio") {
    return <AudioIcon />;
  }

  if (type === "text") {
    return <TextIcon />;
  }

  return <ImageIcon />;
}

function TextIcon() {
  return (
    <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
      <path d="M7 3h7l4 4v14H7V3Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
      <path d="M14 3v5h4" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
      <path d="M9.5 12h5M9.5 15h5M9.5 18h3" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
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
