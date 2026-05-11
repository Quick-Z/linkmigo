"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AssetPreviewGrid } from "./asset-preview-grid";
import { logClientAction } from "../_lib/user-action-log";
import {
  apiUrl,
  errorLabel,
  formatBytes,
  formatCompactNumber,
  formatExpiry,
  getApiError,
} from "../_lib/format";

const platformLabels = {
  instagram: "Instagram",
  tiktok: "TikTok",
  douyin: "Douyin",
  kuaishou: "Kuaishou",
  twitter: "Twitter/X",
  bilibili: "Bilibili",
  facebook: "Facebook",
  xiaohongshu: "Xiaohongshu",
  youtube: "YouTube",
};

const copyByLanguage = {
  zh: {
    all: "全选",
    autoDetect: "自动识别",
    closePreview: "关闭预览",
    clearUrl: "清除链接",
    comments: "评论",
    darkMode: "暗色",
    download: "下载",
    downloadSelected: "下载选中项",
    expiredAt: "过期时间",
    favorites: "收藏",
    fullscreen: "全屏播放",
    image: "图片",
    invalidUrl: "请输入完整的 http 或 https 公开链接。",
    invert: "反选",
    language: "语言",
    lightMode: "亮色",
    likes: "点赞",
    mediaTypeAudio: "音频",
    mediaTypeImage: "图片",
    mediaTypeVideo: "视频",
    next: "下一张",
    none: "取消全选",
    openOriginal: "打开原帖",
    progressDownloading: (downloaded, total) => `已下载 ${downloaded} / ${total}`,
    progressFinalizing: "正在整理资源...",
    progressPreparing: "正在定位资源体积...",
    parseDesc: "正在读取公开页面并缓存可展示资源...",
    parseTitle: "正在解析链接...",
    parsing: "解析中...",
    pauseVideo: "暂停视频",
    playVideo: "播放视频",
    pleaseWait: "请稍候",
    platformLabels: {
      instagram: "Instagram",
      tiktok: "TikTok",
      douyin: "抖音",
      kuaishou: "快手",
      twitter: "Twitter/X",
      bilibili: "Bilibili",
      facebook: "Facebook",
      xiaohongshu: "小红书",
      youtube: "YouTube",
    },
    preferences: "偏好设置",
    previous: "上一张",
    progress: "播放进度",
    publicPlatform: "公开平台",
    reset: "重置",
    resourcesCount: (count) => `${count} 个资源`,
    resultAria: "解析结果",
    search: "搜索",
    selectedCount: (count) => `已选 ${count} 个`,
    subtitle: "搜索、收藏并整理社媒灵感，一处完成。",
    urlLabel: "社媒链接",
    urlPlaceholder: "粘贴 Instagram、TikTok、抖音、小红书、快手或 YouTube 链接...",
    video: "视频",
    audio: "音频",
    volume: "音量",
    views: "播放",
    shares: "分享",
  },
  en: {
    all: "All",
    autoDetect: "Auto detect",
    closePreview: "Close preview",
    clearUrl: "Clear URL",
    comments: "Comments",
    darkMode: "Dark",
    download: "Download",
    downloadSelected: "Download Selected",
    expiredAt: "Expired at",
    favorites: "Favorites",
    fullscreen: "Fullscreen",
    image: "Image",
    invalidUrl: "Please enter a full public http or https link.",
    invert: "Invert",
    language: "Language",
    lightMode: "Light",
    likes: "Likes",
    mediaTypeAudio: "Audio",
    mediaTypeImage: "Image",
    mediaTypeVideo: "Video",
    next: "Next",
    none: "None",
    openOriginal: "Open Original Post",
    progressDownloading: (downloaded, total) => `Downloaded ${downloaded} / ${total}`,
    progressFinalizing: "Finalizing resources...",
    progressPreparing: "Measuring resource size...",
    parseDesc: "Fetching public page and caching resources...",
    parseTitle: "Parsing link...",
    parsing: "Parsing...",
    pauseVideo: "Pause video",
    playVideo: "Play video",
    pleaseWait: "Please wait",
    platformLabels: {
      instagram: "Instagram",
      tiktok: "TikTok",
      douyin: "Douyin",
      kuaishou: "Kuaishou",
      twitter: "Twitter/X",
      bilibili: "Bilibili",
      facebook: "Facebook",
      xiaohongshu: "Xiaohongshu",
      youtube: "YouTube",
    },
    preferences: "Preferences",
    previous: "Previous",
    progress: "Playback progress",
    publicPlatform: "Public platform",
    reset: "Reset",
    resourcesCount: (count) => `${count} ${count === 1 ? "Resource" : "Resources"}`,
    resultAria: "Parse result",
    search: "Search",
    selectedCount: (count) => `${count} Selected`,
    subtitle: "Search, collect, and organize social inspiration in one clean workspace.",
    urlLabel: "Social URL",
    urlPlaceholder: "Paste Instagram, TikTok, Douyin, Xiaohongshu, Kuaishou, or YouTube URL...",
    video: "Video",
    audio: "Audio",
    volume: "Volume",
    views: "Views/Plays",
    shares: "Shares",
  },
};

const colorModeTokens = {
  light: {
    pageBackground: "#dfeaf9",
    pageText: "#11233a",
    titleText: "#172235",
    bodyText: "#1b2a40",
    mutedText: "#6b7a8f",
    subtleText: "#708199",
    placeholderText: "#91a0b5",
    panelBorder: "rgba(255,255,255,0.72)",
    panelClass: "border-white/60 bg-white/60 shadow-[0_24px_60px_rgba(129,158,199,0.16)]",
    pageBackdrop: "radial-gradient(circle at top, rgba(255,255,255,0.92), rgba(219,233,252,0.88) 38%, rgba(211,227,248,0.96) 100%)",
    glowA: "rgba(255,255,255,0.4)",
    glowB: "rgba(246,251,255,0.55)",
    glowC: "rgba(255,255,255,0.26)",
    glassGradient: "linear-gradient(135deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.56) 100%)",
    glassGradientSoft: "linear-gradient(135deg, rgba(255,255,255,0.88) 0%, rgba(255,255,255,0.58) 100%)",
    resultGradient: "linear-gradient(135deg, rgba(255,255,255,0.78) 0%, rgba(255,255,255,0.52) 100%)",
    chipText: "#5f7088",
    chipBackground: "rgba(255,255,255,0.62)",
    chipBorder: "rgba(255,255,255,0.7)",
    chipShadow: "inset 0 1px 0 rgba(255,255,255,0.72)",
    inputText: "#122033",
    invalidBackground: "rgba(255,246,248,0.9)",
    invalidText: "#e1526d",
    cardBackground: "rgba(255,255,255,0.72)",
    cardGradient: "linear-gradient(135deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.66) 100%)",
    cardBorder: "rgba(255,255,255,0.68)",
    cardShadow: "0 18px 36px rgba(132, 158, 192, 0.12), inset 0 1px 0 rgba(255,255,255,0.76)",
    disabledBackground: "rgba(255,255,255,0.62)",
    disabledBorder: "rgba(255,255,255,0.56)",
    disabledText: "#7c8da4",
    iconBackground: "rgba(255,255,255,0.85)",
    mediaOverlay: "rgba(8,17,31,0.1)",
    modalHeaderBackground: "rgba(255,255,255,0.24)",
    modalPanelBackground: "rgba(255,255,255,0.28)",
    selectionBackground: "rgba(255,255,255,0.76)",
    modalButtonBackground: "rgba(255,255,255,0.52)",
    modalButtonText: "#142033",
    previewBackdropOverlay: "radial-gradient(circle at center, rgba(255,255,255,0.34), rgba(15,23,42,0.42) 72%)",
    previewBackdropVeil: "linear-gradient(135deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.08) 48%, rgba(9,18,32,0.34) 100%)",
    toolbarBackground: "rgba(255,255,255,0.42)",
    toolbarText: "#122033",
  },
  dark: {
    pageBackground: "#0a1220",
    pageText: "#e5edf8",
    titleText: "#f4f8ff",
    bodyText: "#eaf1fb",
    mutedText: "#a6b4c8",
    subtleText: "#93a2b8",
    placeholderText: "#7f90a9",
    panelBorder: "rgba(180,207,240,0.22)",
    panelClass: "border-white/12 bg-[#152033]/58 shadow-[0_28px_70px_rgba(0,0,0,0.36)]",
    pageBackdrop: "radial-gradient(circle at top, rgba(41,66,103,0.68), rgba(13,24,42,0.96) 42%, rgba(7,13,24,0.98) 100%)",
    glowA: "rgba(77,108,153,0.24)",
    glowB: "rgba(20,198,219,0.12)",
    glowC: "rgba(255,255,255,0.08)",
    glassGradient: "linear-gradient(135deg, rgba(31,45,70,0.74) 0%, rgba(12,22,39,0.52) 100%)",
    glassGradientSoft: "linear-gradient(135deg, rgba(43,59,86,0.72) 0%, rgba(14,24,42,0.58) 100%)",
    resultGradient: "linear-gradient(135deg, rgba(26,40,63,0.78) 0%, rgba(12,23,42,0.62) 100%)",
    chipText: "#b5c3d7",
    chipBackground: "rgba(20,31,50,0.72)",
    chipBorder: "rgba(184,211,242,0.16)",
    chipShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
    inputText: "#f0f6ff",
    invalidBackground: "rgba(70,26,42,0.64)",
    invalidText: "#ff93aa",
    cardBackground: "rgba(18,31,52,0.86)",
    cardGradient: "linear-gradient(135deg, rgba(35,53,82,0.9) 0%, rgba(12,24,43,0.82) 100%)",
    cardBorder: "rgba(154,195,236,0.24)",
    cardShadow: "0 22px 48px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.1)",
    disabledBackground: "rgba(29,45,70,0.82)",
    disabledBorder: "rgba(176,205,239,0.28)",
    disabledText: "#d8e6f8",
    iconBackground: "rgba(164,198,235,0.14)",
    mediaOverlay: "rgba(0,0,0,0.18)",
    modalHeaderBackground: "rgba(12,23,42,0.66)",
    modalPanelBackground: "rgba(8,15,28,0.58)",
    selectionBackground: "rgba(154,195,236,0.12)",
    modalButtonBackground: "rgba(31,47,73,0.78)",
    modalButtonText: "#f0f6ff",
    previewBackdropOverlay: "radial-gradient(circle at center, rgba(70,96,130,0.18), rgba(4,10,20,0.72) 72%)",
    previewBackdropVeil: "linear-gradient(135deg, rgba(7,14,27,0.38) 0%, rgba(31,48,76,0.2) 46%, rgba(3,8,17,0.76) 100%)",
    toolbarBackground: "rgba(7,14,27,0.74)",
    toolbarText: "#eef5ff",
  },
};

const darkPlatformThemeOverrides = {
  instagram: {
    accent: "#FF5EA8",
    accentStrong: "#FEDA75",
    accentText: "#FFD1E5",
    accentMuted: "#F6A4C8",
    buttonText: "#FFF3F8",
    border: "rgba(255, 94, 168, 0.34)",
    borderStrong: "rgba(254, 218, 117, 0.42)",
    ring: "rgba(255, 94, 168, 0.22)",
    panelShadow: "0 28px 70px rgba(214, 41, 118, 0.22), 0 14px 34px rgba(79, 91, 213, 0.15)",
    buttonShadow: "0 18px 38px rgba(214, 41, 118, 0.28), 0 8px 20px rgba(254, 218, 117, 0.12)",
    selectedShadow: "0 22px 42px rgba(214, 41, 118, 0.26)",
    progressGradient: "linear-gradient(90deg, #FEDA75 0%, #FA7E1E 24%, #D62976 52%, #962FBF 76%, #4F5BD5 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(214,41,118,0.22) 0%, rgba(254,218,117,0.2) 34%, rgba(255,255,255,0.1) 52%, rgba(150,47,191,0.24) 76%, rgba(79,91,213,0.2) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(254,218,117,0.28) 0%, rgba(214,41,118,0.32) 48%, rgba(79,91,213,0.34) 100%)",
  },
  tiktok: {
    accent: "#25F4EE",
    accentStrong: "#FE2C55",
    accentText: "#B6FFFC",
    accentMuted: "#88ECE9",
    buttonText: "#EAFFFE",
    border: "rgba(37, 244, 238, 0.36)",
    borderStrong: "rgba(44, 111, 255, 0.52)",
    ring: "rgba(37, 244, 238, 0.22)",
    panelShadow: "0 28px 70px rgba(37, 244, 238, 0.18), 0 14px 34px rgba(44, 111, 255, 0.18)",
    buttonShadow: "0 18px 38px rgba(37, 244, 238, 0.24), 0 8px 20px rgba(44, 111, 255, 0.2)",
    selectedShadow: "0 22px 42px rgba(37, 244, 238, 0.2), 0 8px 18px rgba(44, 111, 255, 0.2)",
    progressGradient: "linear-gradient(90deg, #25F4EE 0%, rgba(255,255,255,0.86) 48%, #FE2C55 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(37,244,238,0.22) 0%, rgba(255,255,255,0.1) 48%, rgba(254,44,85,0.22) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(37,244,238,0.32) 0%, rgba(255,255,255,0.08) 46%, rgba(254,44,85,0.3) 100%)",
  },
  douyin: {
    accent: "#25F4EE",
    accentStrong: "#FE2C55",
    accentText: "#B8FFFC",
    accentMuted: "#8EECEA",
    buttonText: "#ECFFFE",
    border: "rgba(37, 244, 238, 0.36)",
    borderStrong: "rgba(44, 111, 255, 0.52)",
    ring: "rgba(37, 244, 238, 0.22)",
    panelShadow: "0 28px 70px rgba(37, 244, 238, 0.18), 0 14px 34px rgba(44, 111, 255, 0.18)",
    buttonShadow: "0 18px 38px rgba(37, 244, 238, 0.24), 0 8px 20px rgba(44, 111, 255, 0.2)",
    selectedShadow: "0 22px 42px rgba(37, 244, 238, 0.2), 0 8px 18px rgba(44, 111, 255, 0.2)",
    progressGradient: "linear-gradient(90deg, #25F4EE 0%, rgba(255,255,255,0.82) 48%, #FE2C55 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(37,244,238,0.22) 0%, rgba(255,255,255,0.1) 50%, rgba(254,44,85,0.22) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(37,244,238,0.32) 0%, rgba(255,255,255,0.08) 48%, rgba(254,44,85,0.3) 100%)",
  },
  kuaishou: {
    accent: "#FF7A2F",
    accentStrong: "#FE3666",
    accentText: "#FFD7C3",
    accentMuted: "#F4A078",
    buttonText: "#FFF3EC",
    border: "rgba(255, 122, 47, 0.36)",
    borderStrong: "rgba(254, 54, 102, 0.48)",
    ring: "rgba(255, 80, 0, 0.22)",
    panelShadow: "0 28px 70px rgba(255, 80, 0, 0.2), 0 14px 34px rgba(254, 54, 102, 0.14)",
    buttonShadow: "0 18px 38px rgba(255, 80, 0, 0.26), 0 8px 20px rgba(254, 54, 102, 0.16)",
    selectedShadow: "0 22px 42px rgba(255, 80, 0, 0.24), 0 8px 18px rgba(254, 54, 102, 0.14)",
    progressGradient: "linear-gradient(90deg, #FF5000 0%, #FF9B58 54%, #FE3666 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(255,80,0,0.24) 0%, rgba(255,255,255,0.1) 48%, rgba(254,54,102,0.22) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(255,80,0,0.34) 0%, rgba(255,255,255,0.08) 50%, rgba(254,54,102,0.3) 100%)",
  },
  youtube: {
    accent: "#FF335C",
    accentStrong: "#FF0033",
    accentText: "#FFC9D3",
    accentMuted: "#F59AA9",
    buttonText: "#FFF0F3",
    border: "rgba(255, 51, 92, 0.36)",
    borderStrong: "rgba(255, 255, 255, 0.22)",
    ring: "rgba(255, 51, 92, 0.22)",
    panelShadow: "0 28px 70px rgba(255, 0, 51, 0.2), 0 14px 34px rgba(0, 0, 0, 0.24)",
    buttonShadow: "0 18px 38px rgba(255, 0, 51, 0.26), 0 8px 20px rgba(255, 255, 255, 0.08)",
    selectedShadow: "0 22px 42px rgba(255, 0, 51, 0.24)",
    progressGradient: "linear-gradient(90deg, #FF0033 0%, #FF6A85 54%, #FFFFFF 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(255,0,51,0.24) 0%, rgba(255,255,255,0.1) 48%, rgba(33,33,33,0.42) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(255,0,51,0.34) 0%, rgba(255,255,255,0.1) 48%, rgba(33,33,33,0.5) 100%)",
  },
  bilibili: {
    accent: "#40D7FF",
    accentStrong: "#FF8CB3",
    accentText: "#BEEFFF",
    accentMuted: "#92DDF5",
    buttonText: "#E8FAFF",
    border: "rgba(64, 215, 255, 0.36)",
    borderStrong: "rgba(251, 114, 153, 0.48)",
    ring: "rgba(64, 215, 255, 0.22)",
    panelShadow: "0 28px 70px rgba(0, 161, 214, 0.2), 0 14px 34px rgba(251, 114, 153, 0.14)",
    buttonShadow: "0 18px 38px rgba(0, 161, 214, 0.26), 0 8px 20px rgba(251, 114, 153, 0.16)",
    selectedShadow: "0 22px 42px rgba(0, 161, 214, 0.22), 0 8px 18px rgba(251, 114, 153, 0.16)",
    progressGradient: "linear-gradient(90deg, #00A1D6 0%, #FFFFFF 54%, #FB7299 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(0,161,214,0.24) 0%, rgba(255,255,255,0.1) 48%, rgba(251,114,153,0.22) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(0,161,214,0.34) 0%, rgba(255,255,255,0.08) 52%, rgba(251,114,153,0.3) 100%)",
  },
  twitter: {
    accent: "#1DA1F2",
    accentStrong: "#FFFFFF",
    accentText: "#D4F0FF",
    accentMuted: "#9ED3F3",
    buttonText: "#F4FBFF",
    border: "rgba(29, 161, 242, 0.36)",
    borderStrong: "rgba(255, 255, 255, 0.24)",
    ring: "rgba(29, 161, 242, 0.22)",
    panelShadow: "0 28px 70px rgba(29, 161, 242, 0.2), 0 14px 34px rgba(0, 0, 0, 0.24)",
    buttonShadow: "0 18px 38px rgba(29, 161, 242, 0.26), 0 8px 20px rgba(255, 255, 255, 0.08)",
    selectedShadow: "0 22px 42px rgba(29, 161, 242, 0.24)",
    progressGradient: "linear-gradient(90deg, #1DA1F2 0%, #AAB8C2 58%, #FFFFFF 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(29,161,242,0.24) 0%, rgba(255,255,255,0.1) 50%, rgba(170,184,194,0.22) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(29,161,242,0.34) 0%, rgba(255,255,255,0.08) 48%, rgba(20,23,26,0.54) 100%)",
  },
  facebook: {
    accent: "#5AA2FF",
    accentStrong: "#1877F2",
    accentText: "#D7E9FF",
    accentMuted: "#A4CBFA",
    buttonText: "#F3F8FF",
    border: "rgba(90, 162, 255, 0.36)",
    borderStrong: "rgba(24, 119, 242, 0.52)",
    ring: "rgba(90, 162, 255, 0.22)",
    panelShadow: "0 28px 70px rgba(24, 119, 242, 0.22), 0 14px 34px rgba(59, 89, 152, 0.16)",
    buttonShadow: "0 18px 38px rgba(24, 119, 242, 0.28), 0 8px 20px rgba(255, 255, 255, 0.08)",
    selectedShadow: "0 22px 42px rgba(24, 119, 242, 0.24)",
    progressGradient: "linear-gradient(90deg, #1877F2 0%, #5AA2FF 58%, #FFFFFF 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(24,119,242,0.24) 0%, rgba(255,255,255,0.1) 48%, rgba(59,89,152,0.22) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(24,119,242,0.34) 0%, rgba(255,255,255,0.08) 52%, rgba(59,89,152,0.34) 100%)",
  },
  xiaohongshu: {
    accent: "#FF5369",
    accentStrong: "#FF2442",
    accentText: "#FFD1D8",
    accentMuted: "#F6A0AC",
    buttonText: "#FFF2F4",
    border: "rgba(255, 83, 105, 0.36)",
    borderStrong: "rgba(255, 36, 66, 0.52)",
    ring: "rgba(255, 83, 105, 0.22)",
    panelShadow: "0 28px 70px rgba(255, 36, 66, 0.22), 0 14px 34px rgba(0, 0, 0, 0.2)",
    buttonShadow: "0 18px 38px rgba(255, 36, 66, 0.28), 0 8px 20px rgba(255, 255, 255, 0.08)",
    selectedShadow: "0 22px 42px rgba(255, 36, 66, 0.24)",
    progressGradient: "linear-gradient(90deg, #FF2442 0%, #FF8A9A 58%, #FFFFFF 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(255,36,66,0.24) 0%, rgba(255,255,255,0.1) 48%, rgba(51,51,51,0.28) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(255,36,66,0.36) 0%, rgba(255,255,255,0.08) 48%, rgba(51,51,51,0.4) 100%)",
  },
  neutral: {
    accentStrong: "#c4d2e6",
    accentText: "#d7e2f2",
    accentMuted: "#aebbd0",
    buttonText: "#edf4ff",
    border: "rgba(196, 210, 230, 0.26)",
    borderStrong: "rgba(196, 210, 230, 0.38)",
  },
};

const actionButtonBaseClass =
  "lm-themed-action inline-flex h-10 cursor-pointer items-center justify-center whitespace-nowrap rounded-full border px-4 text-sm font-semibold backdrop-blur-xl transition duration-300 disabled:cursor-not-allowed disabled:shadow-none";
const glassPanelClass =
  "border backdrop-blur-[24px]";
const themeTransition =
  "background-color 640ms cubic-bezier(0.22,1,0.36,1), border-color 640ms cubic-bezier(0.22,1,0.36,1), box-shadow 640ms cubic-bezier(0.22,1,0.36,1), color 640ms cubic-bezier(0.22,1,0.36,1), transform 180ms ease";
const floatingScrollbarInsetPx = 12;
const shareUrlPattern = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/i;
const trailingUrlPunctuationPattern = /[)"'.。,;:!?，；：！？、】》」』”’]+$/u;

const buttonThemes = {
  instagram: {
    accent: "#D62976",
    accentStrong: "#962FBF",
    accentText: "#7A1F52",
    accentMuted: "#B43B75",
    buttonText: "#6D1F4D",
    border: "rgba(214, 41, 118, 0.34)",
    borderStrong: "rgba(150, 47, 191, 0.42)",
    ring: "rgba(214, 41, 118, 0.18)",
    panelShadow: "0 24px 60px rgba(214, 41, 118, 0.14), 0 14px 34px rgba(79, 91, 213, 0.1)",
    buttonShadow: "0 18px 36px rgba(214, 41, 118, 0.16), 0 8px 18px rgba(79, 91, 213, 0.11)",
    selectedShadow: "0 20px 38px rgba(214, 41, 118, 0.16)",
    glassEnd: "rgba(255, 243, 248, 0.74)",
    cardEnd: "rgba(255, 247, 250, 0.86)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.94) 0%, rgba(255,244,248,0.92) 38%, rgba(255,239,221,0.96) 100%)",
    progressGradient: "linear-gradient(90deg, #FEDA75 0%, #FA7E1E 24%, #D62976 52%, #962FBF 76%, #4F5BD5 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(254,218,117,0.34) 0%, rgba(255,250,252,0.92) 32%, rgba(214,41,118,0.16) 52%, rgba(150,47,191,0.18) 76%, rgba(79,91,213,0.14) 100%)",
    previewGradient: "linear-gradient(135deg, #FEDA75 0%, #FA7E1E 26%, #D62976 52%, #962FBF 74%, #4F5BD5 100%)",
    mediaTint: "rgba(255, 241, 246, 0.78)",
  },
  tiktok: {
    accent: "#25F4EE",
    accentStrong: "#FE2C55",
    accentText: "#075D5C",
    accentMuted: "#457E82",
    buttonText: "#053F42",
    border: "rgba(37, 244, 238, 0.38)",
    borderStrong: "rgba(14, 92, 255, 0.42)",
    ring: "rgba(37, 244, 238, 0.2)",
    panelShadow: "0 24px 60px rgba(37, 244, 238, 0.14), 0 12px 28px rgba(14, 92, 255, 0.12)",
    buttonShadow: "0 18px 36px rgba(37, 244, 238, 0.16), 0 8px 18px rgba(14, 92, 255, 0.14)",
    selectedShadow: "0 20px 38px rgba(37, 244, 238, 0.14), 0 8px 16px rgba(14, 92, 255, 0.12)",
    glassEnd: "rgba(241, 252, 255, 0.74)",
    cardEnd: "rgba(246, 255, 255, 0.86)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(238,255,255,0.92) 48%, rgba(255,240,245,0.98) 100%)",
    progressGradient: "linear-gradient(90deg, #25F4EE 0%, #F4FFFF 48%, #FE2C55 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(37,244,238,0.28) 0%, rgba(255,255,255,0.96) 48%, rgba(254,44,85,0.16) 100%)",
    previewGradient: "linear-gradient(135deg, #25F4EE 0%, #F6FFFF 50%, #FE2C55 100%)",
    mediaTint: "rgba(238, 254, 255, 0.78)",
  },
  douyin: {
    accent: "#25F4EE",
    accentStrong: "#FE2C55",
    accentText: "#075B5D",
    accentMuted: "#477D84",
    buttonText: "#063F42",
    border: "rgba(37, 244, 238, 0.38)",
    borderStrong: "rgba(14, 92, 255, 0.42)",
    ring: "rgba(37, 244, 238, 0.2)",
    panelShadow: "0 24px 60px rgba(37, 244, 238, 0.14), 0 12px 28px rgba(14, 92, 255, 0.12)",
    buttonShadow: "0 18px 36px rgba(37, 244, 238, 0.16), 0 8px 18px rgba(14, 92, 255, 0.14)",
    selectedShadow: "0 20px 38px rgba(37, 244, 238, 0.14), 0 8px 16px rgba(14, 92, 255, 0.12)",
    glassEnd: "rgba(240, 255, 255, 0.74)",
    cardEnd: "rgba(246, 255, 255, 0.86)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(236,255,255,0.92) 50%, rgba(255,242,246,0.96) 100%)",
    progressGradient: "linear-gradient(90deg, #25F4EE 0%, #FFFFFF 50%, #FE2C55 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(37,244,238,0.28) 0%, rgba(255,255,255,0.96) 50%, rgba(254,44,85,0.16) 100%)",
    previewGradient: "linear-gradient(135deg, #25F4EE 0%, #F7FFFF 50%, #FE2C55 100%)",
    mediaTint: "rgba(238, 254, 255, 0.78)",
  },
  kuaishou: {
    accent: "#FF5000",
    accentStrong: "#FE3666",
    accentText: "#8E3600",
    accentMuted: "#A76652",
    buttonText: "#783000",
    border: "rgba(255, 80, 0, 0.32)",
    borderStrong: "rgba(254, 54, 102, 0.36)",
    ring: "rgba(255, 80, 0, 0.17)",
    panelShadow: "0 24px 60px rgba(255, 80, 0, 0.13), 0 12px 30px rgba(254, 54, 102, 0.08)",
    buttonShadow: "0 18px 36px rgba(255, 80, 0, 0.15), 0 8px 18px rgba(254, 54, 102, 0.1)",
    selectedShadow: "0 20px 38px rgba(255, 80, 0, 0.14), 0 8px 16px rgba(254, 54, 102, 0.08)",
    glassEnd: "rgba(255, 248, 240, 0.76)",
    cardEnd: "rgba(255, 250, 247, 0.88)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(255,248,240,0.94) 52%, rgba(255,242,247,0.96) 100%)",
    progressGradient: "linear-gradient(90deg, #FF5000 0%, #FFB084 54%, #FE3666 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(255,80,0,0.18) 0%, rgba(255,255,255,0.96) 48%, rgba(254,54,102,0.14) 100%)",
    previewGradient: "linear-gradient(135deg, #FFD7BE 0%, #FFF7F0 52%, #FFD6E1 100%)",
    mediaTint: "rgba(255, 248, 240, 0.78)",
  },
  youtube: {
    accent: "#FF0033",
    accentStrong: "#D6002B",
    accentText: "#8F001D",
    accentMuted: "#A94655",
    buttonText: "#7A0019",
    border: "rgba(255, 0, 51, 0.32)",
    borderStrong: "rgba(33, 33, 33, 0.3)",
    ring: "rgba(255, 0, 51, 0.16)",
    panelShadow: "0 24px 60px rgba(255, 0, 51, 0.12), 0 12px 30px rgba(33, 33, 33, 0.08)",
    buttonShadow: "0 18px 36px rgba(255, 0, 51, 0.15), 0 8px 18px rgba(33, 33, 33, 0.08)",
    selectedShadow: "0 20px 38px rgba(255, 0, 51, 0.14)",
    glassEnd: "rgba(255, 246, 247, 0.76)",
    cardEnd: "rgba(255, 249, 250, 0.88)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.94) 0%, rgba(255,245,246,0.93) 50%, rgba(246,249,252,0.98) 100%)",
    progressGradient: "linear-gradient(90deg, #FF0033 0%, #FF4D6D 58%, #FFB3C1 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(255,0,51,0.16) 0%, rgba(255,255,255,0.96) 48%, rgba(33,33,33,0.12) 100%)",
    previewGradient: "linear-gradient(135deg, #FFCCD6 0%, #FFF5F7 50%, #D9DEE5 100%)",
    mediaTint: "rgba(255, 244, 246, 0.78)",
  },
  bilibili: {
    accent: "#00A1D6",
    accentStrong: "#FB7299",
    accentText: "#12637B",
    accentMuted: "#5C7F90",
    buttonText: "#0F5870",
    border: "rgba(0, 161, 214, 0.34)",
    borderStrong: "rgba(251, 114, 153, 0.38)",
    ring: "rgba(0, 161, 214, 0.17)",
    panelShadow: "0 24px 60px rgba(0, 161, 214, 0.13), 0 12px 30px rgba(251, 114, 153, 0.08)",
    buttonShadow: "0 18px 36px rgba(0, 161, 214, 0.15), 0 8px 18px rgba(251, 114, 153, 0.09)",
    selectedShadow: "0 20px 38px rgba(0, 161, 214, 0.14), 0 8px 16px rgba(251, 114, 153, 0.08)",
    glassEnd: "rgba(240, 252, 255, 0.76)",
    cardEnd: "rgba(247, 253, 255, 0.88)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(238,251,255,0.93) 52%, rgba(255,242,247,0.96) 100%)",
    progressGradient: "linear-gradient(90deg, #00A1D6 0%, #FFFFFF 54%, #FB7299 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(0,161,214,0.2) 0%, rgba(255,255,255,0.96) 48%, rgba(251,114,153,0.14) 100%)",
    previewGradient: "linear-gradient(135deg, #CCF5FF 0%, #FFFFFF 52%, #FFD7E4 100%)",
    mediaTint: "rgba(240, 252, 255, 0.78)",
  },
  twitter: {
    accent: "#1DA1F2",
    accentStrong: "#14171A",
    accentText: "#145A8A",
    accentMuted: "#5B7691",
    buttonText: "#12496F",
    border: "rgba(29, 161, 242, 0.32)",
    borderStrong: "rgba(20, 23, 26, 0.26)",
    ring: "rgba(29, 161, 242, 0.17)",
    panelShadow: "0 24px 60px rgba(29, 161, 242, 0.13), 0 12px 30px rgba(20, 23, 26, 0.08)",
    buttonShadow: "0 18px 36px rgba(29, 161, 242, 0.15), 0 8px 18px rgba(20, 23, 26, 0.08)",
    selectedShadow: "0 20px 38px rgba(29, 161, 242, 0.14)",
    glassEnd: "rgba(244, 251, 255, 0.76)",
    cardEnd: "rgba(248, 253, 255, 0.88)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(239,248,255,0.93) 52%, rgba(245,248,250,0.98) 100%)",
    progressGradient: "linear-gradient(90deg, #1DA1F2 0%, #AAB8C2 58%, #14171A 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(29,161,242,0.18) 0%, rgba(255,255,255,0.96) 50%, rgba(170,184,194,0.18) 100%)",
    previewGradient: "linear-gradient(135deg, #D6F0FF 0%, #F5F8FA 52%, #D8E0E7 100%)",
    mediaTint: "rgba(244, 251, 255, 0.78)",
  },
  facebook: {
    accent: "#1877F2",
    accentStrong: "#0D5FD0",
    accentText: "#124B91",
    accentMuted: "#5D78A2",
    buttonText: "#0F3E7A",
    border: "rgba(24, 119, 242, 0.32)",
    borderStrong: "rgba(59, 89, 152, 0.34)",
    ring: "rgba(24, 119, 242, 0.17)",
    panelShadow: "0 24px 60px rgba(24, 119, 242, 0.13), 0 12px 30px rgba(59, 89, 152, 0.08)",
    buttonShadow: "0 18px 36px rgba(24, 119, 242, 0.15), 0 8px 18px rgba(59, 89, 152, 0.09)",
    selectedShadow: "0 20px 38px rgba(24, 119, 242, 0.14)",
    glassEnd: "rgba(244, 249, 255, 0.76)",
    cardEnd: "rgba(248, 252, 255, 0.88)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(239,247,255,0.93) 54%, rgba(246,249,255,0.98) 100%)",
    progressGradient: "linear-gradient(90deg, #1877F2 0%, #7DB6FF 58%, #3B5998 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(24,119,242,0.18) 0%, rgba(255,255,255,0.96) 48%, rgba(59,89,152,0.16) 100%)",
    previewGradient: "linear-gradient(135deg, #D7E9FF 0%, #F6FAFF 52%, #CAD7EF 100%)",
    mediaTint: "rgba(244, 249, 255, 0.78)",
  },
  xiaohongshu: {
    accent: "#FF2442",
    accentStrong: "#D71935",
    accentText: "#921326",
    accentMuted: "#AE4E5E",
    buttonText: "#7D1324",
    border: "rgba(255, 36, 66, 0.32)",
    borderStrong: "rgba(51, 51, 51, 0.24)",
    ring: "rgba(255, 36, 66, 0.17)",
    panelShadow: "0 24px 60px rgba(255, 36, 66, 0.13), 0 12px 30px rgba(51, 51, 51, 0.08)",
    buttonShadow: "0 18px 36px rgba(255, 36, 66, 0.15), 0 8px 18px rgba(51, 51, 51, 0.08)",
    selectedShadow: "0 20px 38px rgba(255, 36, 66, 0.14)",
    glassEnd: "rgba(255, 246, 248, 0.76)",
    cardEnd: "rgba(255, 250, 251, 0.88)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(255,244,246,0.93) 54%, rgba(248,248,248,0.98) 100%)",
    progressGradient: "linear-gradient(90deg, #FF2442 0%, #FF8A9A 58%, #333333 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(255,36,66,0.18) 0%, rgba(255,255,255,0.96) 48%, rgba(51,51,51,0.12) 100%)",
    previewGradient: "linear-gradient(135deg, #FFD3DA 0%, #FFFFFF 52%, #E7E7E7 100%)",
    mediaTint: "rgba(255, 246, 248, 0.78)",
  },
  neutral: {
    accent: "#7b8aa1",
    accentStrong: "#526177",
    accentText: "#405164",
    accentMuted: "#6b7c90",
    buttonText: "#3f5163",
    border: "rgba(123, 138, 161, 0.28)",
    borderStrong: "rgba(123, 138, 161, 0.38)",
    ring: "rgba(123, 138, 161, 0.18)",
    panelShadow: "0 24px 60px rgba(123, 138, 161, 0.12)",
    buttonShadow: "0 18px 36px rgba(123, 138, 161, 0.14)",
    selectedShadow: "0 20px 38px rgba(123, 138, 161, 0.14)",
    glassEnd: "rgba(245, 248, 252, 0.74)",
    cardEnd: "rgba(249, 251, 255, 0.86)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.94) 0%, rgba(244,247,250,0.95) 100%)",
    progressGradient: "linear-gradient(90deg, #d2d8e2 0%, #7b8aa1 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(231,236,244,0.78) 0%, rgba(255,255,255,0.96) 50%, rgba(231,236,244,0.78) 100%)",
    previewGradient: "linear-gradient(135deg, #edf2f7 0%, #f8fafc 100%)",
    mediaTint: "rgba(244, 247, 250, 0.8)",
  },
};

export function SocialDownloaderClient() {
  const [language, setLanguage] = useState("zh");
  const [colorMode, setColorMode] = useState("light");
  const [url, setUrl] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [isUrlInputHovered, setIsUrlInputHovered] = useState(false);
  const [resolveProgress, setResolveProgress] = useState(null);
  const [resolvingPlatform, setResolvingPlatform] = useState("");
  const [selectedAssetIds, setSelectedAssetIds] = useState([]);
  const resolveRunRef = useRef(0);

  const normalizedUrl = extractUrlCandidate(url);
  const canSubmit = Boolean(normalizedUrl) && isValidHttpUrl(normalizedUrl);
  const inputPlatform = detectPlatform(normalizedUrl);
  const copy = copyByLanguage[language] ?? copyByLanguage.zh;
  const inputTheme = getButtonTheme(inputPlatform, colorMode);
  const resolvingTheme = getButtonTheme(resolvingPlatform, colorMode);
  const resultTheme = result ? getButtonTheme(result.platform, colorMode) : getButtonTheme("", colorMode);
  const submitTheme = isLoading ? resolvingTheme : inputTheme;
  const inputDrivenTheme = normalizedUrl ? inputTheme : getButtonTheme("", colorMode);
  const hasOutput = Boolean(isLoading || result || error);
  const selectedAssets = result ? result.assets.filter((asset) => selectedAssetIds.includes(asset.id)) : [];
  const allSelected = result ? result.assets.length > 0 && selectedAssetIds.length === result.assets.length : false;
  const creatorLabel = result?.creator_handle ? `@${result.creator_handle}` : `@${result?.shortcode ?? "linkmigo"}`;
  const expiryText = result ? formatExpiry(result.expires_at, language) : "";

  useEffect(() => {
    const savedLanguage = window.localStorage.getItem("linkmigo-language");
    const savedColorMode = window.localStorage.getItem("linkmigo-color-mode");

    if (savedLanguage === "zh" || savedLanguage === "en") {
      setLanguage(savedLanguage);
    }

    if (savedColorMode === "light" || savedColorMode === "dark") {
      setColorMode(savedColorMode);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("linkmigo-language", language);
  }, [language]);

  useEffect(() => {
    window.localStorage.setItem("linkmigo-color-mode", colorMode);
  }, [colorMode]);

  useEffect(() => {
    if (!result) {
      setSelectedAssetIds([]);
      return;
    }

    setSelectedAssetIds(result.assets.map((asset) => asset.id));
  }, [result]);

  async function onSubmit(event) {
    event?.preventDefault();

    logClientAction("resolve_button_clicked", {
      url: normalizedUrl,
      platform: inputPlatform || "unknown",
      can_submit: canSubmit,
      is_loading: isLoading,
    });

    if (!canSubmit || isLoading) {
      return;
    }

    const runId = resolveRunRef.current + 1;
    resolveRunRef.current = runId;
    setResolvingPlatform(inputPlatform);
    setIsLoading(true);
    setError(null);
    setResult(null);
    setResolveProgress(createInitialResolveProgress());
    setSelectedAssetIds([]);

    try {
      const response = await fetch("/api/v1/instagram/resolve/jobs", {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: normalizedUrl }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw payload;
      }

      const immediateResult = applyResolveJobPayload(payload, runId);

      if (immediateResult) {
        setResult(immediateResult);
        return;
      }

      const resolved = await pollResolveJob(payload.job_id, runId);

      if (resolved && resolveRunRef.current === runId) {
        setResult(resolved);
      }
    } catch (caught) {
      if (resolveRunRef.current === runId) {
        setError(getApiError(caught));
      }
    } finally {
      if (resolveRunRef.current === runId) {
        setIsLoading(false);
        setResolveProgress(null);
      }
    }
  }

  function onUrlChange(event) {
    const nextValue = event.target.value;
    const extractedUrl = extractUrlCandidate(nextValue);

    setUrl(extractedUrl && isValidHttpUrl(extractedUrl) ? extractedUrl : nextValue);
  }

  async function pollResolveJob(jobId, runId) {
    if (!jobId) {
      throw new Error("解析任务创建失败，请稍后重试。");
    }

    let delayMs = 250;

    while (resolveRunRef.current === runId) {
      await sleep(delayMs);
      delayMs = 600;

      const response = await fetch(`/api/v1/instagram/resolve/jobs/${encodeURIComponent(jobId)}`, {
        cache: "no-store",
      });
      const payload = await response.json();

      if (!response.ok) {
        throw payload;
      }

      const resultPayload = applyResolveJobPayload(payload, runId);

      if (resultPayload) {
        return resultPayload;
      }
    }

    return null;
  }

  function applyResolveJobPayload(payload, runId) {
    if (resolveRunRef.current !== runId) {
      return null;
    }

    setResolveProgress(payload?.progress ?? createInitialResolveProgress(payload?.phase));

    if (payload?.status === "completed" && payload.result) {
      return payload.result;
    }

    if (payload?.status === "failed") {
      throw { error: payload.error };
    }

    return null;
  }

  function reset() {
    logClientAction("reset_button_clicked", {
      had_url: Boolean(url.trim()),
      had_result: Boolean(result),
      had_error: Boolean(error),
    });

    resolveRunRef.current += 1;
    setUrl("");
    setResult(null);
    setError(null);
    setIsLoading(false);
    setIsInputFocused(false);
    setIsUrlInputHovered(false);
    setResolveProgress(null);
    setResolvingPlatform("");
    setSelectedAssetIds([]);
  }

  function clearUrl() {
    logClientAction("url_clear_clicked", {
      had_url: Boolean(url.trim()),
      platform: inputPlatform || "unknown",
    });

    setUrl("");
    setError(null);
    setIsInputFocused(false);
    setIsUrlInputHovered(false);
  }

  function toggleAsset(assetId) {
    setSelectedAssetIds((current) => {
      const isSelected = current.includes(assetId);
      const next = isSelected
        ? current.filter((id) => id !== assetId)
        : [...current, assetId];

      logClientAction("asset_selection_toggled", {
        asset_id: assetId,
        selected: !isSelected,
        selected_count: next.length,
      });

      return next;
    });
  }

  function toggleAll() {
    if (!result) {
      return;
    }

    const next = allSelected ? [] : result.assets.map((asset) => asset.id);

    logClientAction("asset_select_all_toggled", {
      selected_all: !allSelected,
      selected_count: next.length,
      asset_count: result.assets.length,
      request_id: result.request_id,
    });

    setSelectedAssetIds(next);
  }

  function invertSelection() {
    if (!result) {
      return;
    }

    setSelectedAssetIds((current) => {
      const next = result.assets
        .map((asset) => asset.id)
        .filter((assetId) => !current.includes(assetId));

      logClientAction("asset_selection_inverted", {
        selected_count: next.length,
        asset_count: result.assets.length,
        request_id: result.request_id,
      });

      return next;
    });
  }

  function downloadSelected() {
    if (!result || selectedAssets.length === 0) {
      return;
    }

    logClientAction("bulk_asset_download_clicked", {
      request_id: result.request_id,
      platform: result.platform,
      shortcode: result.shortcode,
      selected_asset_ids: selectedAssets.map((asset) => asset.id),
      selected_count: selectedAssets.length,
    });

    if (selectedAssets.length === 1) {
      triggerBrowserDownload(apiUrl(selectedAssets[0].download_url));
      return;
    }

    const assetIds = selectedAssets.map((asset) => asset.id).join(",");
    const zipUrl = `/api/v1/instagram/requests/${result.request_id}/download.zip?asset_ids=${encodeURIComponent(assetIds)}`;

    triggerBrowserDownload(apiUrl(zipUrl));
  }

  const formStyle = buildSearchShellStyle(
    inputTheme,
    isInputFocused,
    normalizedUrl && !canSubmit,
  );
  const searchButtonStyle = buildPrimaryButtonStyle(submitTheme, !canSubmit || isLoading);
  const resetButtonStyle = buildSecondaryButtonStyle(inputDrivenTheme);
  const resultSecondaryButtonStyle = buildSecondaryButtonStyle(resultTheme);

  return (
    <main
      className="lm-page relative h-[100svh] overflow-hidden transition-colors duration-700"
      data-color-mode={colorMode}
      style={{ backgroundColor: inputDrivenTheme.pageBackground, color: inputDrivenTheme.pageText }}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 transition-[background] duration-700" style={{ background: inputDrivenTheme.pageBackdrop }} />
        <div className="absolute left-[-12%] top-[-8%] h-[32rem] w-[32rem] rounded-full blur-[90px] transition-colors duration-700" style={{ backgroundColor: inputDrivenTheme.glowA }} />
        <div className="absolute right-[-8%] top-[6%] h-[28rem] w-[28rem] rounded-full blur-[90px] transition-colors duration-700" style={{ backgroundColor: inputDrivenTheme.glowB }} />
        <div className="absolute bottom-[-14%] left-[18%] h-[20rem] w-[20rem] rounded-full blur-[80px] transition-colors duration-700" style={{ backgroundColor: inputDrivenTheme.glowC }} />
      </div>

      <section className="relative mx-auto flex h-full w-full max-w-[1480px] flex-col overflow-hidden px-3 py-4 sm:px-7 sm:py-6 lg:px-10">
        <PreferenceControls
          colorMode={colorMode}
          copy={copy}
          language={language}
          onColorModeChange={setColorMode}
          onLanguageChange={setLanguage}
          theme={inputDrivenTheme}
        />

        <div
          className="mx-auto w-full max-w-6xl pb-3 pt-0 transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform"
          style={{
            transform: hasOutput ? "translate3d(0,0,0)" : "translate3d(0, clamp(2.75rem, 11svh, 7.5rem), 0)",
          }}
        >
          <div className={`relative ${hasOutput ? "pt-12 sm:pt-14" : "pt-20 sm:pt-24 lg:pt-28"}`}>
            {!hasOutput ? (
              <MediaStack mutedDarkPlayIcon={colorMode === "dark" && !normalizedUrl} theme={inputDrivenTheme} />
            ) : (
              <MediaStack compact theme={inputDrivenTheme} />
            )}

            <div className="relative z-10">
              <div className="text-center">
                <h1
                  className={`font-serif italic leading-[0.98] transition-all duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                    hasOutput ? "text-[2rem] sm:text-[2.75rem]" : "text-[3.2rem] sm:text-[5.4rem] lg:text-[6.25rem]"
                  }`}
                  style={{ color: inputDrivenTheme.titleText }}
                >
                  LinkMigo
                </h1>
                <p
                  className={`mx-auto max-w-2xl overflow-hidden transition-all duration-500 ${
                    hasOutput ? "mt-1 max-h-0 text-sm opacity-0" : "mt-4 max-h-14 text-base opacity-100 sm:text-lg"
                  }`}
                  style={{ color: inputDrivenTheme.mutedText }}
                >
                  {copy.subtitle}
                </p>
              </div>

              <form
                noValidate
                className={`mx-auto w-full max-w-6xl rounded-[2rem] transition-all duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                  hasOutput ? "mt-4 rounded-[1.5rem] p-3 sm:p-4" : "mt-6 p-4 sm:p-5"
                } ${glassPanelClass} ${inputDrivenTheme.panelClass}`}
                onSubmit={onSubmit}
                style={formStyle}
              >
                <label className="sr-only" htmlFor="social-url">
                  {copy.urlLabel}
                </label>
                <div
                  className="relative"
                  onMouseEnter={() => setIsUrlInputHovered(true)}
                  onMouseLeave={() => setIsUrlInputHovered(false)}
                >
                  <input
                    aria-describedby={normalizedUrl && !canSubmit ? "social-url-error" : undefined}
                    aria-invalid={Boolean(normalizedUrl && !canSubmit)}
                    autoCapitalize="none"
                    autoComplete="off"
                    className={`lm-url-input w-full appearance-none bg-transparent py-0 pl-1 pr-12 text-base font-medium outline-none sm:text-[1.15rem] ${
                      hasOutput ? "h-11 sm:h-12" : "h-14 sm:h-16"
                    }`}
                    id="social-url"
                    inputMode="url"
                    name="social-url"
                    onBlur={() => setIsInputFocused(false)}
                    onChange={onUrlChange}
                    onFocus={() => setIsInputFocused(true)}
                    placeholder={copy.urlPlaceholder}
                    spellCheck={false}
                    style={{
                      "--lm-input-text-color": inputDrivenTheme.inputText,
                      "--lm-placeholder-color": inputDrivenTheme.placeholderText,
                      caretColor: inputDrivenTheme.accent,
                      color: inputDrivenTheme.inputText,
                    }}
                    type="text"
                    value={url}
                  />

                  {url ? (
                    <button
                      aria-label={copy.clearUrl}
                      aria-hidden={!isUrlInputHovered}
                      className={`lm-themed-action absolute right-0 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full border transition-[background-color,border-color,box-shadow,color,opacity,transform] duration-300 ease-out ${
                        isUrlInputHovered ? "cursor-pointer opacity-100" : "pointer-events-none cursor-default opacity-0"
                      }`}
                      onClick={clearUrl}
                      onMouseDown={(event) => event.preventDefault()}
                      style={buildUrlClearButtonStyle(inputDrivenTheme)}
                      tabIndex={isUrlInputHovered ? 0 : -1}
                      title={copy.clearUrl}
                      type="button"
                    >
                      <ClearIcon />
                    </button>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:flex-nowrap sm:items-center">
                  {result ? (
                    <button
                      className={actionButtonBaseClass}
                      onClick={reset}
                      style={resetButtonStyle}
                      type="button"
                    >
                      {copy.reset}
                    </button>
                  ) : null}

                  {normalizedUrl && !canSubmit ? (
                    <span id="social-url-error" className="text-sm font-medium" style={{ color: inputDrivenTheme.invalidText }}>
                      {copy.invalidUrl}
                    </span>
                  ) : null}

                  <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
                    <button
                      className={`${actionButtonBaseClass} h-11 w-full min-w-[6rem] px-6 sm:w-auto`}
                      disabled={!canSubmit || isLoading}
                      style={searchButtonStyle}
                      type="submit"
                    >
                      {isLoading ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="block size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                          {copy.parsing}
                        </span>
                      ) : (
                        copy.search
                      )}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
        </div>

        <div
          className={`mx-auto flex min-h-0 w-full max-w-6xl flex-1 transition-all duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            hasOutput ? "mt-4 translate-y-0 opacity-100" : "pointer-events-none mt-0 translate-y-6 opacity-0"
          }`}
        >
          {error ? (
            <div
              className={`${glassPanelClass} ${inputDrivenTheme.panelClass} flex w-full gap-3 rounded-[1.75rem] p-5 backdrop-blur-2xl`}
              role="alert"
              style={buildErrorShellStyle(inputDrivenTheme)}
            >
              <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-current text-xs font-bold">
                !
              </span>
              <div className="grid gap-1">
                <strong className="text-sm" style={{ color: inputDrivenTheme.accentText }}>{errorLabel(error, language)}</strong>
                <span className="text-sm" style={{ color: inputDrivenTheme.mutedText }}>{error.message}</span>
              </div>
            </div>
          ) : null}

          {isLoading ? <ResolvingState copy={copy} language={language} progress={resolveProgress} theme={resolvingTheme} /> : null}

          {result ? (
            <section className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-[2rem] border backdrop-blur-[28px]" style={buildResultShellStyle(resultTheme)} aria-label={copy.resultAria}>
              <div className="grid shrink-0 gap-3 border-b px-3 pb-1 pt-3 sm:px-5 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center" style={{ borderColor: resultTheme.panelBorder }}>
                <div className="lm-inline-scroll -mt-1 flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto pb-5 pt-1">
                  <GlassChip theme={resultTheme}>{getPlatformLabel(result.platform, copy)}</GlassChip>
                  <a
                    className="lm-themed-action inline-flex h-9 max-w-full shrink-0 cursor-pointer items-center rounded-full border px-3 text-[13px] font-semibold transition"
                    href={result.canonical_url}
                    rel="noreferrer"
                    style={buildLinkChipStyle(resultTheme)}
                    target="_blank"
                  >
                    <span className="truncate">{copy.openOriginal}</span>
                  </a>
                  <GlassChip theme={resultTheme}>{copy.resourcesCount(result.assets.length)}</GlassChip>
                  <GlassChip theme={resultTheme}>{copy.selectedCount(selectedAssetIds.length)}</GlassChip>
                </div>

                {expiryText ? (
                  <div className="justify-self-start xl:justify-self-end">
                    <GlassChip alignRight theme={resultTheme}>
                      {copy.expiredAt} {expiryText}
                    </GlassChip>
                  </div>
                ) : null}
              </div>

              <div className="grid shrink-0 gap-3 border-b px-3 py-3 sm:px-5 2xl:grid-cols-[minmax(0,1fr)_auto] 2xl:items-start" style={{ borderColor: resultTheme.panelBorder }}>
                <div className="-mt-1 flex min-w-0 flex-wrap items-center gap-2.5 overflow-visible pb-1 pt-1">
                  <div className="mr-1 shrink-0 text-lg font-semibold" style={{ color: resultTheme.bodyText }}>{creatorLabel}</div>
                  {createMetricItems(result.metrics, copy).map((item) => (
                    <StatPill key={item.label} label={item.label} language={language} theme={resultTheme} value={item.value} />
                  ))}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2 2xl:flex-nowrap 2xl:justify-end">
                  <button className={`${actionButtonBaseClass} h-9 px-3 text-[13px]`} onClick={toggleAll} style={resultSecondaryButtonStyle} type="button">
                    {allSelected ? copy.none : copy.all}
                  </button>
                  <button className={`${actionButtonBaseClass} h-9 px-3 text-[13px]`} onClick={invertSelection} style={resultSecondaryButtonStyle} type="button">
                    {copy.invert}
                  </button>
                  <button
                    className={`${actionButtonBaseClass} h-9 px-4 text-[13px]`}
                    disabled={selectedAssets.length === 0}
                    onClick={downloadSelected}
                    style={buildPrimaryButtonStyle(resultTheme, selectedAssets.length === 0)}
                    type="button"
                  >
                    {copy.downloadSelected}
                  </button>
                </div>
              </div>

              <FloatingScrollArea theme={resultTheme}>
                <AssetPreviewGrid
                  assets={result.assets}
                  onToggleAsset={toggleAsset}
                  selectedAssetIds={selectedAssetIds}
                  theme={resultTheme}
                  colorMode={colorMode}
                  language={language}
                  labels={copy}
                />
              </FloatingScrollArea>
            </section>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function PreferenceControls({
  colorMode,
  copy,
  language,
  onColorModeChange,
  onLanguageChange,
  theme,
}) {
  return (
    <div
      aria-label={copy.preferences}
      className="absolute inset-x-3 top-3 z-30 sm:inset-x-7 sm:top-5 lg:inset-x-10"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-wrap justify-end gap-2">
        <div className="flex rounded-full border p-1 backdrop-blur-xl" style={buildControlGroupStyle(theme)}>
          {["zh", "en"].map((item) => (
            <button
              aria-pressed={language === item}
              className="h-8 cursor-pointer rounded-full px-3 text-xs font-semibold transition sm:text-sm"
              key={item}
              onClick={() => onLanguageChange(item)}
              style={buildSegmentStyle(theme, language === item)}
              type="button"
            >
              {item === "zh" ? "中文" : "EN"}
            </button>
          ))}
        </div>

        <div className="flex rounded-full border p-1 backdrop-blur-xl" style={buildControlGroupStyle(theme)}>
          {["light", "dark"].map((item) => (
            <button
              aria-pressed={colorMode === item}
              className="h-8 cursor-pointer rounded-full px-3 text-xs font-semibold transition sm:text-sm"
              key={item}
              onClick={() => onColorModeChange(item)}
              style={buildSegmentStyle(theme, colorMode === item)}
              type="button"
            >
              {item === "light" ? copy.lightMode : copy.darkMode}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function FloatingScrollArea({ children, theme }) {
  const viewportRef = useRef(null);
  const [scrollbarState, setScrollbarState] = useState({
    hasOverflow: false,
    trackHeight: 0,
    thumbHeight: 0,
    thumbTop: 0,
  });

  const updateScrollbar = useCallback(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return;
    }

    const { clientHeight, scrollHeight, scrollTop } = viewport;
    const hasOverflow = scrollHeight - clientHeight > 2;
    const trackHeight = Math.max(0, clientHeight - floatingScrollbarInsetPx * 2);
    const thumbHeight = hasOverflow
      ? Math.max(42, Math.round((clientHeight / scrollHeight) * trackHeight))
      : 0;
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = hasOverflow
      ? Math.round((scrollTop / (scrollHeight - clientHeight)) * maxThumbTop)
      : 0;

    setScrollbarState((current) => {
      if (
        current.hasOverflow === hasOverflow &&
        current.trackHeight === trackHeight &&
        current.thumbHeight === thumbHeight &&
        current.thumbTop === thumbTop
      ) {
        return current;
      }

      return { hasOverflow, trackHeight, thumbHeight, thumbTop };
    });
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return undefined;
    }

    updateScrollbar();

    const resizeObserver = new ResizeObserver(updateScrollbar);

    resizeObserver.observe(viewport);

    if (viewport.firstElementChild) {
      resizeObserver.observe(viewport.firstElementChild);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [children, updateScrollbar]);

  return (
    <div className="group relative min-h-0 flex-1">
      <div
        className="lm-floating-scroll h-full min-h-0 overflow-y-auto px-3 py-3 sm:px-5"
        onScroll={updateScrollbar}
        ref={viewportRef}
      >
        {children}
      </div>

      <div
        aria-hidden="true"
        className={`pointer-events-none absolute right-3 top-1/2 w-2 -translate-y-1/2 rounded-full bg-white/22 opacity-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] backdrop-blur-md transition-opacity duration-300 ease-out sm:right-4 ${
          scrollbarState.hasOverflow ? "group-hover:opacity-100 group-focus-within:opacity-100" : ""
        }`}
        style={{ height: `${scrollbarState.trackHeight}px` }}
      >
        <span
          className="absolute left-1/2 block w-1.5 rounded-full border border-white/42 bg-current shadow-[0_8px_24px_rgba(15,23,42,0.14)] transition-[height,transform,background-color,color] duration-300 ease-out"
          style={{
            color: hexToRgba(theme.accent, 0.48),
            height: `${scrollbarState.thumbHeight}px`,
            transform: `translate(-50%, ${scrollbarState.thumbTop}px)`,
          }}
        />
      </div>
    </div>
  );
}

function MediaStack({ compact = false, mutedDarkPlayIcon = false, theme }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute left-1/2 z-0 hidden -translate-x-1/2 sm:block ${
        compact ? "top-0 h-16 w-[20rem]" : "top-0 h-28 w-[26rem]"
      }`}
    >
      <MediaPreviewCard
        className={`${compact ? "left-2 top-5 h-16 w-28" : "left-3 top-8 h-20 w-36"} -rotate-[11deg] animate-[lm-float-a_6.5s_ease-in-out_infinite]`}
        theme={theme}
        variant="gallery"
      />
      <MediaPreviewCard
        className={`${compact ? "left-[7.2rem] top-0 h-[4.6rem] w-32" : "left-[8.6rem] top-0 h-24 w-40"} rotate-[1deg] animate-[lm-float-b_7.4s_ease-in-out_infinite]`}
        mutedDarkPlayIcon={mutedDarkPlayIcon}
        theme={theme}
        variant="video"
      />
      <MediaPreviewCard
        className={`${compact ? "left-[13.8rem] top-6 h-[3.8rem] w-24" : "left-[15.8rem] top-9 h-[4.8rem] w-32"} rotate-[9deg] animate-[lm-float-c_6.9s_ease-in-out_infinite]`}
        theme={theme}
        variant="photo"
      />
    </div>
  );
}

function MediaPreviewCard({ className, mutedDarkPlayIcon = false, theme, variant }) {
  return (
    <div
      className={`absolute overflow-hidden rounded-[1.25rem] border border-white/75 bg-white/72 p-2 shadow-[0_18px_34px_rgba(128,157,191,0.15)] backdrop-blur-xl ${className}`}
      style={buildMediaCardStyle(theme)}
    >
      {variant === "video" ? (
        <div className="relative h-full w-full overflow-hidden rounded-[0.95rem]" style={buildMediaSurfaceStyle(theme, 0.14)}>
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.24),rgba(255,255,255,0))]" />
          <div className="absolute inset-x-2 top-2 h-2 rounded-full bg-white/55" />
          <div className="absolute inset-x-0 bottom-0 top-0 grid place-items-center">
            <span className="grid size-9 place-items-center rounded-full bg-white/82 shadow-[0_12px_24px_rgba(129,158,199,0.18)]">
              <span
                className="ml-0.5 block size-0 border-y-[7px] border-l-[12px] border-y-transparent"
                style={{ borderLeftColor: mutedDarkPlayIcon ? "#172235" : theme.accentText, transition: themeTransition }}
              />
            </span>
          </div>
        </div>
      ) : variant === "gallery" ? (
        <div className="grid h-full w-full grid-cols-2 gap-1.5 rounded-[0.95rem]">
          <div className="rounded-[0.85rem]" style={buildMediaSurfaceStyle(theme, 0.12)} />
          <div className="grid gap-1.5">
            <div className="rounded-[0.85rem] bg-white/72" />
            <div className="rounded-[0.85rem]" style={buildMediaSurfaceStyle(theme, 0.08)} />
          </div>
        </div>
      ) : (
        <div className="relative h-full w-full overflow-hidden rounded-[0.95rem]" style={buildMediaSurfaceStyle(theme, 0.12)}>
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.6),rgba(255,255,255,0)_48%)]" />
          <div className="absolute bottom-2 left-2 right-2 rounded-[0.85rem] bg-white/72 px-2 py-1">
            <div className="h-1.5 rounded-full bg-white" />
          </div>
        </div>
      )}
    </div>
  );
}

function ResolvingState({ copy, language, progress, theme }) {
  const progressPercent = resolveProgressPercent(progress);
  const hasMeasuredProgress = progressPercent != null;
  const progressDetail = resolveProgressDetail(progress, copy, language);

  return (
    <section
      aria-label={copy.parseTitle}
      aria-live="polite"
      className={`${glassPanelClass} ${theme.panelClass} grid min-h-0 w-full flex-1 content-start gap-5 rounded-[2rem] p-5 sm:p-6`}
      style={buildResultShellStyle(theme)}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <div
            className="mc-orbit relative size-14 shrink-0 rounded-full border"
            style={{
              backgroundColor: theme.iconBackground,
              borderColor: theme.panelBorder,
              color: theme.accent,
              boxShadow: theme.buttonShadow,
              transition: themeTransition,
            }}
          />
          <div className="grid min-w-0 gap-1">
            <div className="text-base font-semibold" style={{ color: theme.bodyText }}>{copy.parseTitle}</div>
            <div className="truncate text-sm font-medium" style={{ color: theme.mutedText }}>{progressDetail}</div>
          </div>
        </div>
        <div className="text-sm font-semibold" style={{ color: theme.accentText }}>
          {hasMeasuredProgress ? `${progressPercent}%` : copy.pleaseWait}
        </div>
      </div>

      <div
        aria-valuemax={hasMeasuredProgress ? 100 : undefined}
        aria-valuemin={hasMeasuredProgress ? 0 : undefined}
        aria-valuenow={hasMeasuredProgress ? progressPercent : undefined}
        className="h-2 overflow-hidden rounded-full bg-white/65"
        role="progressbar"
      >
        <span
          className={hasMeasuredProgress
            ? "block h-full rounded-full transition-[width] duration-500 ease-out"
            : "mc-progress-bar block h-full w-1/2 rounded-full"}
          style={{
            backgroundImage: theme.progressGradient,
            width: hasMeasuredProgress ? `${progressPercent}%` : undefined,
          }}
        />
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
        {[0, 1, 2, 3].map((index) => (
          <div
            className="grid gap-3 rounded-[1.35rem] border border-white/65 bg-white/68 p-3 backdrop-blur-xl"
            key={index}
            style={buildSkeletonCardStyle(theme)}
          >
            <div className="mc-skeleton aspect-[4/4.2] rounded-[1rem]" style={buildSkeletonStyle(theme)} />
            <div className="mc-skeleton h-3 rounded-full" style={buildSkeletonStyle(theme)} />
            <div className="mc-skeleton h-3 w-2/3 rounded-full" style={buildSkeletonStyle(theme)} />
          </div>
        ))}
      </div>
    </section>
  );
}

function GlassChip({ alignRight = false, children, theme }) {
  return (
    <span
      className={`inline-flex h-10 shrink-0 items-center whitespace-nowrap rounded-full border px-3 text-sm font-semibold text-[#5f7088] ${alignRight ? "justify-end" : ""}`}
      style={buildChipStyle(theme)}
    >
      {children}
    </span>
  );
}

function ClearIcon() {
  return (
    <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
      <path d="M7 7l10 10M17 7 7 17" stroke="currentColor" strokeLinecap="round" strokeWidth="2.4" />
    </svg>
  );
}

function StatPill({ label, language, theme, value }) {
  return (
    <div
      className="inline-flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 py-2 text-sm"
      style={buildChipStyle(theme)}
    >
      <span className="shrink-0 text-xs font-semibold" style={{ color: theme.subtleText }}>{label}</span>
      <span className="font-semibold" style={{ color: value == null ? theme.mutedText : theme.accentStrong }}>
        {formatCompactNumber(value, language)}
      </span>
    </div>
  );
}

function createMetricItems(metrics, copy) {
  return [
    { label: copy.likes, value: metrics?.like_count },
    { label: copy.comments, value: metrics?.comment_count },
    { label: copy.views, value: metrics?.view_count },
    { label: copy.shares, value: metrics?.share_count },
    { label: copy.favorites, value: metrics?.save_count },
  ];
}

function createInitialResolveProgress(phase = "resolving") {
  return {
    mode: "indeterminate",
    phase,
    percent: null,
    downloaded_bytes: 0,
    total_bytes: null,
    asset_index: null,
    asset_count: null,
  };
}

function resolveProgressPercent(progress) {
  if (progress?.mode !== "percent" || !Number.isFinite(progress.percent)) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(progress.percent)));
}

function resolveProgressDetail(progress, copy, language) {
  const percent = resolveProgressPercent(progress);
  const downloadedBytes = Number(progress?.downloaded_bytes) || 0;
  const totalBytes = Number(progress?.total_bytes) || 0;

  if (percent != null && totalBytes > 0) {
    return copy.progressDownloading(
      formatBytes(downloadedBytes),
      formatBytes(totalBytes),
    );
  }

  if (progress?.phase === "preparing_download") {
    return copy.progressPreparing;
  }

  if (progress?.phase === "completed") {
    return copy.progressFinalizing;
  }

  if (progress?.asset_count) {
    return language === "en"
      ? `Caching ${progress.asset_count} resources...`
      : `正在缓存 ${progress.asset_count} 个资源...`;
  }

  return copy.parseDesc;
}

function sleep(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function buildSearchShellStyle(theme, isFocused, isInvalid) {
  if (isInvalid) {
    return {
      backgroundColor: theme.invalidBackground,
      backgroundImage: theme.glassGradient,
      borderColor: "rgba(225, 82, 109, 0.36)",
      boxShadow: isFocused
        ? "0 24px 58px rgba(225, 82, 109, 0.12), 0 0 0 4px rgba(225, 82, 109, 0.12)"
        : "0 24px 58px rgba(128, 157, 191, 0.14)",
      transition: themeTransition,
    };
  }

  const active = theme ?? buttonThemes.neutral;

  return {
    backgroundColor: hexToRgba(active.accent, active.colorMode === "dark" ? 0.12 : 0.055),
    backgroundImage: active.glassGradient,
    borderColor: active.borderStrong,
    boxShadow: isFocused
      ? `${active.panelShadow}, 0 0 0 4px ${active.ring}`
      : active.panelShadow,
    transition: themeTransition,
  };
}

function buildPrimaryButtonStyle(theme, disabled) {
  if (disabled) {
    return {
      color: theme.disabledText,
      backgroundColor: theme.disabledBackground,
      backgroundImage: theme.glassGradientSoft,
      borderColor: theme.disabledBorder,
      boxShadow: "none",
      opacity: 1,
      transition: themeTransition,
    };
  }

  return {
    color: theme.buttonText,
    backgroundColor: hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.2 : 0.14),
    backgroundImage: theme.glassGradientSoft,
    borderColor: theme.borderStrong,
    boxShadow: theme.buttonShadow,
    transition: themeTransition,
    ...buildActionInteractionVars(theme),
  };
}

function buildSecondaryButtonStyle(theme) {
  return {
    color: theme.accentText,
    backgroundColor: hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.14 : 0.07),
    backgroundImage: theme.glassGradientSoft,
    borderColor: theme.border,
    boxShadow: `0 12px 28px ${hexToRgba(theme.accent, 0.1)}`,
    transition: themeTransition,
    ...buildActionInteractionVars(theme),
  };
}

function buildUrlClearButtonStyle(theme) {
  return {
    color: theme.accentText,
    backgroundColor: hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.18 : 0.09),
    backgroundImage: theme.glassGradientSoft,
    borderColor: theme.border,
    boxShadow: `0 10px 24px ${hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.16 : 0.1)}`,
    transition: themeTransition,
    ...buildActionInteractionVars(theme),
  };
}

function buildChipStyle(theme, emphasized = false) {
  return {
    color: emphasized ? theme.accentText : theme.chipText,
    backgroundColor: emphasized ? hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.16 : 0.08) : theme.chipBackground,
    backgroundImage: theme.glassGradientSoft,
    borderColor: emphasized ? theme.border : theme.chipBorder,
    boxShadow: emphasized ? `0 12px 24px ${hexToRgba(theme.accent, 0.08)}` : theme.chipShadow,
    transition: themeTransition,
  };
}

function buildLinkChipStyle(theme) {
  return {
    color: theme.accentText,
    backgroundColor: hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.16 : 0.08),
    backgroundImage: theme.glassGradientSoft,
    borderColor: theme.border,
    boxShadow: `0 12px 24px ${hexToRgba(theme.accent, 0.08)}`,
    transition: themeTransition,
    ...buildActionInteractionVars(theme),
  };
}

function buildResultShellStyle(theme) {
  return {
    backgroundColor: hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.1 : 0.045),
    backgroundImage: theme.resultGradient,
    borderColor: theme.panelBorder,
    boxShadow: theme.panelShadow,
    transition: themeTransition,
  };
}

function buildErrorShellStyle(theme) {
  return {
    color: theme.accentText,
    backgroundColor: hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.12 : 0.06),
    backgroundImage: theme.resultGradient,
    borderColor: theme.borderStrong,
    boxShadow: theme.panelShadow,
    transition: themeTransition,
  };
}

function buildSkeletonCardStyle(theme) {
  return {
    boxShadow: `0 18px 36px ${hexToRgba(theme.accent, 0.1)}`,
    transition: themeTransition,
  };
}

function buildSkeletonStyle(theme) {
  const baseAlpha = theme.colorMode === "dark" ? 0.22 : 0.11;
  const sheenAlpha = theme.colorMode === "dark" ? 0.22 : 0.18;
  const peakAlpha = theme.colorMode === "dark" ? 0.34 : 0.3;
  const edgeAlpha = theme.colorMode === "dark" ? 0.08 : 0.48;

  return {
    "--lm-skeleton-base": hexToRgba(theme.accent, baseAlpha),
    "--lm-skeleton-edge": `rgba(255,255,255,${edgeAlpha})`,
    "--lm-skeleton-sheen": hexToRgba(theme.accent, sheenAlpha),
    "--lm-skeleton-sheen-peak": hexToRgba(theme.accent, peakAlpha),
    transition: themeTransition,
  };
}

function buildMediaCardStyle(theme) {
  return {
    backgroundColor: hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.12 : 0.055),
    borderColor: theme.panelBorder,
    boxShadow: theme.buttonShadow,
    transition: themeTransition,
  };
}

function buildMediaSurfaceStyle(theme, alpha) {
  return {
    backgroundColor: hexToRgba(theme.accent, alpha),
    backgroundImage: theme.glassGradientSoft,
    transition: themeTransition,
  };
}

function buildControlGroupStyle(theme) {
  return {
    backgroundColor: theme.chipBackground,
    backgroundImage: theme.glassGradientSoft,
    borderColor: theme.chipBorder,
    boxShadow: theme.chipShadow,
    transition: themeTransition,
  };
}

function buildSegmentStyle(theme, isActive) {
  return {
    color: isActive ? theme.buttonText : theme.mutedText,
    backgroundColor: isActive ? hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.2 : 0.12) : "transparent",
    boxShadow: isActive ? theme.buttonShadow : "none",
    transition: themeTransition,
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

function triggerBrowserDownload(href) {
  const link = document.createElement("a");

  link.href = href;
  link.rel = "noreferrer";
  document.body.append(link);
  link.click();
  link.remove();
}

function getPlatformLabel(platform, copy = copyByLanguage.zh) {
  return platform ? copy.platformLabels?.[platform] ?? platformLabels[platform] ?? platform : copy.publicPlatform;
}

function getButtonTheme(platform, colorMode = "light") {
  const surface = colorModeTokens[colorMode] ?? colorModeTokens.light;
  const platformTheme = buttonThemes[platform] ?? buttonThemes.neutral;
  const platformKey = buttonThemes[platform] ? platform : "neutral";
  const colorModeOverride = colorMode === "dark"
    ? darkPlatformThemeOverrides[platformKey] ?? darkPlatformThemeOverrides.neutral
    : {};

  return {
    ...platformTheme,
    ...colorModeOverride,
    ...surface,
    colorMode,
  };
}

function detectPlatform(value) {
  try {
    const hostname = new URL(extractUrlCandidate(value)).hostname.toLowerCase().replace(/^www\./, "");

    if (hostname === "instagram.com" || hostname.endsWith(".instagram.com") || hostname.endsWith("ddinstagram.com")) {
      return "instagram";
    }

    if (hostname === "tiktok.com" || hostname.endsWith(".tiktok.com")) {
      return "tiktok";
    }

    if (hostname === "douyin.com" || hostname.endsWith(".douyin.com") || hostname === "iesdouyin.com" || hostname.endsWith(".iesdouyin.com")) {
      return "douyin";
    }

    if (hostname === "kuaishou.com" || hostname.endsWith(".kuaishou.com") || hostname === "gifshow.com" || hostname.endsWith(".gifshow.com")) {
      return "kuaishou";
    }

    if (hostname === "youtube.com" || hostname.endsWith(".youtube.com") || hostname === "youtu.be" || hostname.endsWith(".youtu.be") || hostname === "youtube-nocookie.com" || hostname.endsWith(".youtube-nocookie.com")) {
      return "youtube";
    }

    if (hostname === "bilibili.com" || hostname.endsWith(".bilibili.com") || hostname === "b23.tv") {
      return "bilibili";
    }

    if (hostname === "twitter.com" || hostname.endsWith(".twitter.com") || hostname === "x.com" || hostname.endsWith(".x.com") || hostname === "vxtwitter.com" || hostname === "fixvx.com") {
      return "twitter";
    }

    if (hostname === "facebook.com" || hostname.endsWith(".facebook.com") || hostname === "fb.watch") {
      return "facebook";
    }

    if (hostname === "xiaohongshu.com" || hostname.endsWith(".xiaohongshu.com") || hostname === "xhslink.com" || hostname.endsWith(".xhslink.com") || hostname === "xhs.cn" || hostname.endsWith(".xhs.cn") || hostname === "rednote.com" || hostname.endsWith(".rednote.com")) {
      return "xiaohongshu";
    }
  } catch {
    return "";
  }

  return "";
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(extractUrlCandidate(value));

    return ["http:", "https:"].includes(parsed.protocol) && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function extractUrlCandidate(value) {
  const trimmed = String(value || "").trim();
  const match = trimmed.match(shareUrlPattern);
  const candidate = match ? match[0] : trimmed;

  return candidate.replace(trailingUrlPunctuationPattern, "");
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
