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
  threads: "Threads",
  tiktok: "TikTok",
  douyin: "Douyin",
  kuaishou: "Kuaishou",
  acfun: "AcFun",
  twitter: "Twitter/X",
  bilibili: "Bilibili",
  facebook: "Facebook",
  pinterest: "Pinterest",
  reddit: "Reddit",
  v2ex: "V2EX",
  xiaoyuzhou: "Xiaoyuzhou",
  xiaohongshu: "Xiaohongshu",
  youtube: "YouTube",
  pornhub: "Pornhub",
};

const keywordSearchPlatforms = [
  { id: "xiaohongshu", color: "#ff2442", enabled: true, loginUrl: "" },
  { id: "instagram", color: "#c13584", enabled: false, loginUrl: "https://www.instagram.com/accounts/login/" },
  { id: "douyin", color: "#111827", enabled: false, loginUrl: "https://www.douyin.com/" },
];

const copyByLanguage = {
  zh: {
    all: "全选",
    autoDetect: "自动识别",
    closePreview: "关闭预览",
    clearUrl: "清除链接",
    comments: "评论",
    darkMode: "暗色",
    download: "下载",
    downloadAll: "全部下载",
    downloadCurrent: "下载当前资源",
    downloadContents: "选择下载内容",
    downloadMedia: "帖子资源（图片和视频）",
    downloadPostText: "帖子文案（标题、正文）",
    downloadComments: "评论",
    commentCount: "评论数量",
    commentCountHint: "最多下载前 100 条",
    startDownload: "开始下载",
    cancel: "取消",
    downloadSelectedPosts: "下载选中帖子",
    downloadSelected: "下载选中项",
    expiredAt: "过期时间",
    favorites: "收藏",
    followers: "粉丝",
    following: "关注",
    fullscreen: "全屏播放",
    image: "图片",
    invalidUrl: "请输入完整的 http 或 https 公开链接。",
    invert: "反选",
    language: "语言",
    lightMode: "亮色",
    likes: "点赞",
    author: "作者",
    body: "正文内容",
    closeDetails: "关闭信息",
    commentsEnd: "已加载当前公开页面返回的评论",
    commentsLoadFailed: "评论加载失败",
    commentsPanel: "评论区",
    commentsUnavailablePartial: "已读取到评论数，但公开页面没有返回评论内容",
    commentsVisibleCount: (loaded, total) => `已显示 ${loaded} / ${total}`,
    copiedBody: "文案已复制",
    copiedComment: "评论已复制",
    copiedTitle: "标题已复制",
    copyBody: "复制文案",
    copyComment: "点击复制评论",
    copyFailed: "复制失败，请手动复制",
    copyTitle: "复制标题",
    loadMoreComments: "加载更多评论",
    loadMorePosts: "加载更多帖子",
    loadingComments: "正在加载评论...",
    loadingMoreComments: "正在加载更多...",
    loadingMorePosts: "正在加载更多帖子...",
    loadingPostDetails: "正在读取帖子详情...",
    noContent: "暂无正文内容",
    noComments: "暂无评论",
    noTags: "暂无 tag",
    openComments: "查看评论",
    openPostDetails: "查看文案和数据",
    postDetails: "帖子信息",
    retry: "重试",
    tags: "Tag",
    text: "文本",
    title: "标题",
    voiceComment: "语音评论",
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
      threads: "Threads",
      tiktok: "TikTok",
      douyin: "抖音",
      kuaishou: "快手",
      acfun: "AcFun",
      twitter: "Twitter/X",
      bilibili: "Bilibili",
      facebook: "Facebook",
      pinterest: "Pinterest",
      reddit: "Reddit",
      v2ex: "V2EX",
      xiaoyuzhou: "小宇宙",
      xiaohongshu: "小红书",
      youtube: "YouTube",
      pornhub: "Pornhub",
    },
    preferences: "偏好设置",
    previous: "上一张",
    progress: "播放进度",
    profilePosts: "主页帖子",
    profileDownloadDownloading: "正在下载",
    profileDownloadFailed: "整帖失败",
    profileDownloadPartialFailed: "部分失败",
    profileDownloadQueued: "等待下载",
    profileDownloadSuccess: "已下载",
    profileDownloadProgress: (done, total) => `下载中 ${done} / ${total}`,
    posts: "帖子",
    postsCount: (count) => `${count} 个帖子`,
    postsEnd: "已加载当前可展示的主页帖子",
    postsPartial: "当前公开快照只返回了这些帖子",
    postsVisibleCount: (loaded, total) => `已显示 ${loaded} / ${total}`,
    publicPlatform: "公开平台",
    reset: "重置",
    resourcesCount: (count) => `${count} 个资源`,
    resultAria: "解析结果",
    search: "搜索",
    searchPlatform: "搜索平台",
    comingSoon: "即将支持",
    searchDownloadUnavailable: "搜索结果暂不支持批量下载",
    searchLoginTitle: "搜索需要登录",
    searchLoginHint: "请先登录对应平台，再重新搜索。",
    searchLoginButton: "登录",
    searchRetryButton: "已登录",
    selectedPostsCount: (count) => `已选 ${count} 个帖子`,
    selectedCount: (count) => `已选 ${count} 个`,
    selectPost: "选中帖子",
    subtitle: "搜索、收藏并整理社媒灵感，一处完成。",
    urlLabel: "社媒链接",
    urlPlaceholder: "支持 Instagram、Threads、小红书、小宇宙、V2EX、Reddit、Pinterest、YouTube、TikTok、抖音、快手、B 站、A 站链接...",
    unselectPost: "取消选中帖子",
    video: "视频",
    audio: "音频",
    volume: "音量",
    views: "播放",
    shares: "分享",
    openProfile: "打开主页",
    openPost: "打开帖子",
    verified: "已认证",
  },
  en: {
    all: "All",
    autoDetect: "Auto detect",
    closePreview: "Close preview",
    clearUrl: "Clear URL",
    comments: "Comments",
    darkMode: "Dark",
    download: "Download",
    downloadAll: "Download All",
    downloadCurrent: "Download current resource",
    downloadContents: "Choose download contents",
    downloadMedia: "Post resources (images and videos)",
    downloadPostText: "Post text (title and body)",
    downloadComments: "Comments",
    commentCount: "Comment count",
    commentCountHint: "Up to the first 100 comments",
    startDownload: "Start download",
    cancel: "Cancel",
    downloadSelectedPosts: "Download Selected Posts",
    downloadSelected: "Download Selected",
    expiredAt: "Expired at",
    favorites: "Favorites",
    followers: "Followers",
    following: "Following",
    fullscreen: "Fullscreen",
    image: "Image",
    invalidUrl: "Please enter a full public http or https link.",
    invert: "Invert",
    language: "Language",
    lightMode: "Light",
    likes: "Likes",
    author: "Author",
    body: "Caption",
    closeDetails: "Close details",
    commentsEnd: "Loaded comments from the public page.",
    commentsLoadFailed: "Failed to load comments",
    commentsPanel: "Comments",
    commentsUnavailablePartial: "Comment count was found, but the public page did not return comment text.",
    commentsVisibleCount: (loaded, total) => `Showing ${loaded} / ${total}`,
    copiedBody: "Caption copied",
    copiedComment: "Comment copied",
    copiedTitle: "Title copied",
    copyBody: "Copy caption",
    copyComment: "Click to copy comment",
    copyFailed: "Copy failed. Please copy manually.",
    copyTitle: "Copy title",
    loadMoreComments: "Load more comments",
    loadMorePosts: "Load more posts",
    loadingComments: "Loading comments...",
    loadingMoreComments: "Loading more...",
    loadingMorePosts: "Loading more posts...",
    loadingPostDetails: "Loading post details...",
    noContent: "No caption available",
    noComments: "No comments",
    noTags: "No tags",
    openComments: "View comments",
    openPostDetails: "View caption and data",
    postDetails: "Post Details",
    retry: "Retry",
    tags: "Tags",
    text: "Text",
    title: "Title",
    voiceComment: "Voice comment",
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
      threads: "Threads",
      tiktok: "TikTok",
      douyin: "Douyin",
      kuaishou: "Kuaishou",
      acfun: "AcFun",
      twitter: "Twitter/X",
      bilibili: "Bilibili",
      facebook: "Facebook",
      pinterest: "Pinterest",
      reddit: "Reddit",
      v2ex: "V2EX",
      xiaoyuzhou: "Xiaoyuzhou",
      xiaohongshu: "Xiaohongshu",
      youtube: "YouTube",
      pornhub: "Pornhub",
    },
    preferences: "Preferences",
    previous: "Previous",
    progress: "Playback progress",
    profilePosts: "Profile Posts",
    profileDownloadDownloading: "Downloading",
    profileDownloadFailed: "Failed",
    profileDownloadPartialFailed: "Partial",
    profileDownloadQueued: "Queued",
    profileDownloadSuccess: "Downloaded",
    profileDownloadProgress: (done, total) => `Downloading ${done} / ${total}`,
    posts: "Posts",
    postsCount: (count) => `${count} ${count === 1 ? "Post" : "Posts"}`,
    postsEnd: "Loaded available profile posts",
    postsPartial: "The current public snapshot only returned these posts",
    postsVisibleCount: (loaded, total) => `Showing ${loaded} / ${total}`,
    publicPlatform: "Public platform",
    reset: "Reset",
    resourcesCount: (count) => `${count} ${count === 1 ? "Resource" : "Resources"}`,
    resultAria: "Parse result",
    search: "Search",
    searchPlatform: "Search platforms",
    comingSoon: "Coming soon",
    searchDownloadUnavailable: "Bulk download is unavailable for search results",
    searchLoginTitle: "Login required for search",
    searchLoginHint: "Sign in to the platform, then search again.",
    searchLoginButton: "Log in",
    searchRetryButton: "Signed in",
    selectedPostsCount: (count) => `${count} Posts Selected`,
    selectedCount: (count) => `${count} Selected`,
    selectPost: "Select post",
    subtitle: "Search, collect, and organize social inspiration in one clean workspace.",
    urlLabel: "Social URL",
    urlPlaceholder: "Paste Instagram, Xiaohongshu, Xiaoyuzhou, V2EX, Reddit, Pinterest, YouTube, TikTok, Douyin, Kuaishou, Bilibili, or AcFun URL...",
    unselectPost: "Unselect post",
    video: "Video",
    audio: "Audio",
    volume: "Volume",
    views: "Views/Plays",
    shares: "Shares",
    openProfile: "Open Profile",
    openPost: "Open Post",
    verified: "Verified",
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

// Cohere is intentionally isolated from the existing platform themes. The
// default theme continues to use the original per-platform colour language;
// opting into Cohere swaps the complete surface/token set instead.
const cohereThemeTokens = {
  light: {
    pageBackground: "#ffffff",
    pageText: "#212121",
    titleText: "#17171c",
    bodyText: "#212121",
    mutedText: "#616161",
    subtleText: "#75758a",
    placeholderText: "#93939f",
    panelBorder: "#d9d9dd",
    panelClass: "border-[#d9d9dd] bg-white/90 shadow-[0_24px_60px_rgba(33,33,33,0.08)]",
    pageBackdrop: "radial-gradient(circle at 9% 12%, rgba(255,119,89,0.26), transparent 31%), radial-gradient(circle at 74% 24%, rgba(24,99,220,0.18), transparent 38%), radial-gradient(circle at 50% 100%, rgba(0,60,51,0.12), transparent 42%), linear-gradient(135deg, #ffffff 0%, #eeece7 100%)",
    glowA: "rgba(255,119,89,0.22)",
    glowB: "rgba(24,99,220,0.16)",
    glowC: "rgba(0,60,51,0.12)",
    glassGradient: "linear-gradient(135deg, rgba(255,255,255,0.98) 0%, rgba(238,236,231,0.9) 100%)",
    glassGradientSoft: "linear-gradient(135deg, rgba(255,255,255,0.96) 0%, rgba(245,245,242,0.9) 100%)",
    resultGradient: "linear-gradient(135deg, rgba(255,255,255,0.98) 0%, rgba(241,245,255,0.94) 52%, rgba(237,252,233,0.9) 100%)",
    chipText: "#212121",
    chipBackground: "rgba(255,255,255,0.86)",
    chipBorder: "#d9d9dd",
    chipShadow: "inset 0 1px 0 rgba(255,255,255,0.92)",
    inputText: "#212121",
    invalidBackground: "#fff5f2",
    invalidText: "#b30000",
    cardBackground: "#ffffff",
    cardGradient: "linear-gradient(135deg, #ffffff 0%, #f7f7f5 100%)",
    cardBorder: "#f2f2f2",
    cardShadow: "0 14px 30px rgba(33,33,33,0.06)",
    disabledBackground: "#eeece7",
    disabledBorder: "#d9d9dd",
    disabledText: "#93939f",
    iconBackground: "#f1f5ff",
    mediaOverlay: "rgba(0,60,51,0.08)",
    modalHeaderBackground: "rgba(255,255,255,0.9)",
    modalPanelBackground: "rgba(255,255,255,0.94)",
    selectionBackground: "rgba(255,119,89,0.1)",
    modalButtonBackground: "#ffffff",
    modalButtonText: "#212121",
    previewBackdropOverlay: "radial-gradient(circle at center, rgba(255,119,89,0.16), rgba(238,236,231,0.7) 72%)",
    previewBackdropVeil: "linear-gradient(135deg, rgba(255,119,89,0.14) 0%, rgba(255,255,255,0.34) 48%, rgba(0,60,51,0.16) 100%)",
    toolbarBackground: "rgba(255,255,255,0.9)",
    toolbarText: "#212121",
    accent: "#17171c",
    accentStrong: "#003c33",
    accentText: "#212121",
    accentMuted: "#75758a",
    buttonText: "#ffffff",
    border: "#d9d9dd",
    borderStrong: "#17171c",
    ring: "rgba(76,110,230,0.28)",
    panelShadow: "0 24px 60px rgba(33,33,33,0.08)",
    buttonShadow: "0 14px 28px rgba(0,60,51,0.18)",
    selectedShadow: "0 18px 36px rgba(0,60,51,0.14)",
    glassEnd: "rgba(238,236,231,0.9)",
    cardEnd: "#f7f7f5",
    buttonGradient: "linear-gradient(135deg, #17171c 0%, #003c33 100%)",
    progressGradient: "linear-gradient(90deg, #ff7759 0%, #1863dc 52%, #003c33 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(255,119,89,0.16) 0%, rgba(255,255,255,0.96) 48%, rgba(24,99,220,0.14) 100%)",
    previewGradient: "linear-gradient(135deg, #ffad9b 0%, #f1f5ff 52%, #edfce9 100%)",
    mediaTint: "rgba(255,255,255,0.76)",
  },
  dark: {
    pageBackground: "#071829",
    pageText: "#ffffff",
    titleText: "#ffffff",
    bodyText: "#f5f5f4",
    mutedText: "#b7b7bd",
    subtleText: "#a4a4b0",
    placeholderText: "#93939f",
    panelBorder: "rgba(255,255,255,0.18)",
    panelClass: "border-white/15 bg-[#17171c]/90 shadow-[0_28px_70px_rgba(0,0,0,0.34)]",
    pageBackdrop: "radial-gradient(circle at 7% 12%, rgba(255,119,89,0.36), transparent 30%), radial-gradient(circle at 76% 18%, rgba(76,110,230,0.32), transparent 38%), radial-gradient(circle at 64% 86%, rgba(0,60,51,0.4), transparent 44%), linear-gradient(135deg, #071829 0%, #17171c 56%, #000000 100%)",
    glowA: "rgba(255,119,89,0.28)",
    glowB: "rgba(76,110,230,0.22)",
    glowC: "rgba(0,60,51,0.26)",
    glassGradient: "linear-gradient(135deg, rgba(35,35,42,0.95) 0%, rgba(7,24,41,0.92) 100%)",
    glassGradientSoft: "linear-gradient(135deg, rgba(38,38,46,0.95) 0%, rgba(0,60,51,0.68) 100%)",
    resultGradient: "linear-gradient(135deg, rgba(23,23,28,0.96) 0%, rgba(7,24,41,0.94) 52%, rgba(0,60,51,0.82) 100%)",
    chipText: "#f5f5f4",
    chipBackground: "rgba(23,23,28,0.82)",
    chipBorder: "rgba(255,255,255,0.18)",
    chipShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
    inputText: "#ffffff",
    invalidBackground: "rgba(86,20,18,0.8)",
    invalidText: "#ffad9b",
    cardBackground: "rgba(23,23,28,0.92)",
    cardGradient: "linear-gradient(135deg, rgba(38,38,46,0.96) 0%, rgba(7,24,41,0.9) 100%)",
    cardBorder: "rgba(255,255,255,0.14)",
    cardShadow: "0 18px 42px rgba(0,0,0,0.28)",
    disabledBackground: "rgba(23,23,28,0.72)",
    disabledBorder: "rgba(255,255,255,0.16)",
    disabledText: "#93939f",
    iconBackground: "rgba(255,119,89,0.14)",
    mediaOverlay: "rgba(0,0,0,0.2)",
    modalHeaderBackground: "rgba(23,23,28,0.9)",
    modalPanelBackground: "rgba(7,24,41,0.92)",
    selectionBackground: "rgba(255,119,89,0.15)",
    modalButtonBackground: "rgba(255,255,255,0.08)",
    modalButtonText: "#ffffff",
    previewBackdropOverlay: "radial-gradient(circle at center, rgba(255,119,89,0.2), rgba(0,0,0,0.72) 72%)",
    previewBackdropVeil: "linear-gradient(135deg, rgba(255,119,89,0.22) 0%, rgba(7,24,41,0.26) 48%, rgba(0,0,0,0.72) 100%)",
    toolbarBackground: "rgba(7,24,41,0.88)",
    toolbarText: "#ffffff",
    accent: "#ff7759",
    accentStrong: "#ffad9b",
    accentText: "#ffffff",
    accentMuted: "#ffad9b",
    buttonText: "#17171c",
    border: "rgba(255,119,89,0.34)",
    borderStrong: "rgba(255,173,155,0.5)",
    ring: "rgba(255,119,89,0.28)",
    panelShadow: "0 28px 70px rgba(0,0,0,0.38), 0 12px 30px rgba(0,60,51,0.2)",
    buttonShadow: "0 16px 34px rgba(255,119,89,0.22)",
    selectedShadow: "0 20px 42px rgba(255,119,89,0.2)",
    glassEnd: "rgba(7,24,41,0.92)",
    cardEnd: "rgba(7,24,41,0.9)",
    buttonGradient: "linear-gradient(135deg, #ffffff 0%, #eeece7 100%)",
    progressGradient: "linear-gradient(90deg, #ff7759 0%, #ffad9b 48%, #4c6ee6 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(255,119,89,0.2) 0%, rgba(23,23,28,0.96) 48%, rgba(76,110,230,0.2) 100%)",
    previewGradient: "linear-gradient(135deg, #ff7759 0%, #071829 52%, #003c33 100%)",
    mediaTint: "rgba(7,24,41,0.74)",
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
  acfun: {
    accent: "#FD4C5D",
    accentStrong: "#36A7FF",
    accentText: "#FFD4DA",
    accentMuted: "#F29AA5",
    buttonText: "#FFF2F4",
    border: "rgba(253, 76, 93, 0.36)",
    borderStrong: "rgba(54, 167, 255, 0.46)",
    ring: "rgba(253, 76, 93, 0.22)",
    panelShadow: "0 28px 70px rgba(253, 76, 93, 0.2), 0 14px 34px rgba(54, 167, 255, 0.14)",
    buttonShadow: "0 18px 38px rgba(253, 76, 93, 0.26), 0 8px 20px rgba(54, 167, 255, 0.16)",
    selectedShadow: "0 22px 42px rgba(253, 76, 93, 0.24), 0 8px 18px rgba(54, 167, 255, 0.14)",
    progressGradient: "linear-gradient(90deg, #FD4C5D 0%, #FFFFFF 52%, #36A7FF 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(253,76,93,0.24) 0%, rgba(255,255,255,0.1) 48%, rgba(54,167,255,0.22) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(253,76,93,0.34) 0%, rgba(255,255,255,0.08) 50%, rgba(54,167,255,0.3) 100%)",
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
  pornhub: {
    accent: "#FF9A1F",
    accentStrong: "#F47A00",
    accentText: "#FFE3BA",
    accentMuted: "#F8BF75",
    buttonText: "#FFF6E8",
    border: "rgba(255, 154, 31, 0.38)",
    borderStrong: "rgba(255, 255, 255, 0.24)",
    ring: "rgba(255, 154, 31, 0.24)",
    panelShadow: "0 28px 70px rgba(244, 122, 0, 0.22), 0 14px 34px rgba(0, 0, 0, 0.24)",
    buttonShadow: "0 18px 38px rgba(244, 122, 0, 0.3), 0 8px 20px rgba(255, 255, 255, 0.08)",
    selectedShadow: "0 22px 42px rgba(244, 122, 0, 0.26)",
    progressGradient: "linear-gradient(90deg, #F47A00 0%, #FFB347 58%, #FFFFFF 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(244,122,0,0.26) 0%, rgba(255,255,255,0.1) 48%, rgba(28,28,28,0.44) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(244,122,0,0.36) 0%, rgba(255,255,255,0.1) 48%, rgba(22,22,22,0.56) 100%)",
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
  pinterest: {
    accent: "#FF4A62",
    accentStrong: "#E60023",
    accentText: "#FFD0D8",
    accentMuted: "#F59AA8",
    buttonText: "#FFF1F3",
    border: "rgba(255, 74, 98, 0.36)",
    borderStrong: "rgba(230, 0, 35, 0.48)",
    ring: "rgba(255, 74, 98, 0.22)",
    panelShadow: "0 28px 70px rgba(230, 0, 35, 0.22), 0 14px 34px rgba(0, 0, 0, 0.2)",
    buttonShadow: "0 18px 38px rgba(230, 0, 35, 0.28), 0 8px 20px rgba(255, 255, 255, 0.08)",
    selectedShadow: "0 22px 42px rgba(230, 0, 35, 0.24)",
    progressGradient: "linear-gradient(90deg, #E60023 0%, #FF7A95 58%, #FFFFFF 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(230,0,35,0.24) 0%, rgba(255,255,255,0.1) 48%, rgba(31,31,31,0.3) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(230,0,35,0.36) 0%, rgba(255,255,255,0.08) 48%, rgba(31,31,31,0.44) 100%)",
  },
  reddit: {
    accent: "#FF6A22",
    accentStrong: "#D93A00",
    accentText: "#FFD8C6",
    accentMuted: "#F4A581",
    buttonText: "#FFF4EE",
    border: "rgba(255, 106, 34, 0.38)",
    borderStrong: "rgba(255, 255, 255, 0.22)",
    ring: "rgba(255, 106, 34, 0.24)",
    panelShadow: "0 28px 70px rgba(255, 69, 0, 0.22), 0 14px 34px rgba(0, 0, 0, 0.24)",
    buttonShadow: "0 18px 38px rgba(255, 69, 0, 0.28), 0 8px 20px rgba(255, 255, 255, 0.08)",
    selectedShadow: "0 22px 42px rgba(255, 69, 0, 0.24)",
    progressGradient: "linear-gradient(90deg, #FF4500 0%, #FF9A5A 58%, #FFFFFF 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(255,69,0,0.24) 0%, rgba(255,255,255,0.1) 48%, rgba(31,31,31,0.34) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(255,69,0,0.36) 0%, rgba(255,255,255,0.08) 48%, rgba(31,31,31,0.46) 100%)",
  },
  v2ex: {
    accent: "#5E8FDB",
    accentStrong: "#AFC6E8",
    accentText: "#D9E7FA",
    accentMuted: "#AFC8EA",
    buttonText: "#F0F6FF",
    border: "rgba(94, 143, 219, 0.36)",
    borderStrong: "rgba(175, 198, 232, 0.34)",
    ring: "rgba(94, 143, 219, 0.22)",
    panelShadow: "0 28px 70px rgba(94, 143, 219, 0.18), 0 14px 34px rgba(0, 0, 0, 0.18)",
    buttonShadow: "0 18px 38px rgba(94, 143, 219, 0.24), 0 8px 20px rgba(175, 198, 232, 0.1)",
    selectedShadow: "0 22px 42px rgba(94, 143, 219, 0.22)",
    progressGradient: "linear-gradient(90deg, #5E8FDB 0%, #AFC6E8 56%, #FFFFFF 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(94,143,219,0.24) 0%, rgba(255,255,255,0.1) 48%, rgba(175,198,232,0.18) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(94,143,219,0.34) 0%, rgba(255,255,255,0.08) 48%, rgba(30,41,59,0.36) 100%)",
  },
  xiaoyuzhou: {
    accent: "#22D6C8",
    accentStrong: "#FFE45E",
    accentText: "#BDFCF4",
    accentMuted: "#8FE8DF",
    buttonText: "#ECFFFD",
    border: "rgba(34, 214, 200, 0.36)",
    borderStrong: "rgba(255, 228, 94, 0.4)",
    ring: "rgba(34, 214, 200, 0.22)",
    panelShadow: "0 28px 70px rgba(34, 214, 200, 0.18), 0 14px 34px rgba(255, 228, 94, 0.1)",
    buttonShadow: "0 18px 38px rgba(34, 214, 200, 0.24), 0 8px 20px rgba(255, 228, 94, 0.12)",
    selectedShadow: "0 22px 42px rgba(34, 214, 200, 0.22)",
    progressGradient: "linear-gradient(90deg, #22D6C8 0%, #BDFCF4 52%, #FFE45E 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(34,214,200,0.24) 0%, rgba(255,255,255,0.1) 48%, rgba(255,228,94,0.2) 100%)",
    previewGradient: "linear-gradient(135deg, rgba(34,214,200,0.34) 0%, rgba(255,255,255,0.08) 48%, rgba(255,228,94,0.24) 100%)",
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
const bareV2exUrlPattern = /(?:www\.)?v2ex\.com\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+/i;
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
  acfun: {
    accent: "#FD4C5D",
    accentStrong: "#36A7FF",
    accentText: "#8F2431",
    accentMuted: "#A76572",
    buttonText: "#7B1F2A",
    border: "rgba(253, 76, 93, 0.34)",
    borderStrong: "rgba(54, 167, 255, 0.38)",
    ring: "rgba(253, 76, 93, 0.18)",
    panelShadow: "0 24px 60px rgba(253, 76, 93, 0.13), 0 12px 30px rgba(54, 167, 255, 0.08)",
    buttonShadow: "0 18px 36px rgba(253, 76, 93, 0.16), 0 8px 18px rgba(54, 167, 255, 0.1)",
    selectedShadow: "0 20px 38px rgba(253, 76, 93, 0.15), 0 8px 16px rgba(54, 167, 255, 0.08)",
    glassEnd: "rgba(255, 246, 248, 0.76)",
    cardEnd: "rgba(255, 249, 250, 0.88)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(255,246,248,0.94) 52%, rgba(240,249,255,0.96) 100%)",
    progressGradient: "linear-gradient(90deg, #FD4C5D 0%, #FFFFFF 52%, #36A7FF 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(253,76,93,0.2) 0%, rgba(255,255,255,0.96) 48%, rgba(54,167,255,0.14) 100%)",
    previewGradient: "linear-gradient(135deg, #FFD6DB 0%, #FFFFFF 52%, #D6EFFF 100%)",
    mediaTint: "rgba(255, 246, 248, 0.78)",
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
  pornhub: {
    accent: "#F47A00",
    accentStrong: "#1F1F1F",
    accentText: "#8A4600",
    accentMuted: "#9A6B3E",
    buttonText: "#783B00",
    border: "rgba(244, 122, 0, 0.34)",
    borderStrong: "rgba(31, 31, 31, 0.28)",
    ring: "rgba(244, 122, 0, 0.18)",
    panelShadow: "0 24px 60px rgba(244, 122, 0, 0.13), 0 12px 30px rgba(31, 31, 31, 0.08)",
    buttonShadow: "0 18px 36px rgba(244, 122, 0, 0.16), 0 8px 18px rgba(31, 31, 31, 0.08)",
    selectedShadow: "0 20px 38px rgba(244, 122, 0, 0.15)",
    glassEnd: "rgba(255, 249, 240, 0.76)",
    cardEnd: "rgba(255, 251, 245, 0.88)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(255,248,238,0.94) 54%, rgba(247,248,250,0.98) 100%)",
    progressGradient: "linear-gradient(90deg, #F47A00 0%, #FFB347 58%, #1F1F1F 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(244,122,0,0.2) 0%, rgba(255,255,255,0.96) 48%, rgba(31,31,31,0.12) 100%)",
    previewGradient: "linear-gradient(135deg, #FFE0B2 0%, #FFF8EE 52%, #D9DEE5 100%)",
    mediaTint: "rgba(255, 248, 238, 0.78)",
  },
  pinterest: {
    accent: "#E60023",
    accentStrong: "#9C0017",
    accentText: "#8A0015",
    accentMuted: "#B14557",
    buttonText: "#7B0012",
    border: "rgba(230, 0, 35, 0.32)",
    borderStrong: "rgba(156, 0, 23, 0.34)",
    ring: "rgba(230, 0, 35, 0.17)",
    panelShadow: "0 24px 60px rgba(230, 0, 35, 0.13), 0 12px 30px rgba(31, 31, 31, 0.08)",
    buttonShadow: "0 18px 36px rgba(230, 0, 35, 0.15), 0 8px 18px rgba(31, 31, 31, 0.08)",
    selectedShadow: "0 20px 38px rgba(230, 0, 35, 0.14)",
    glassEnd: "rgba(255, 244, 247, 0.76)",
    cardEnd: "rgba(255, 248, 249, 0.88)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(255,244,246,0.93) 52%, rgba(250,250,250,0.98) 100%)",
    progressGradient: "linear-gradient(90deg, #E60023 0%, #FF7A95 58%, #1F1F1F 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(230,0,35,0.18) 0%, rgba(255,255,255,0.96) 48%, rgba(31,31,31,0.12) 100%)",
    previewGradient: "linear-gradient(135deg, #FFD6DD 0%, #FFF5F7 52%, #D9DEE5 100%)",
    mediaTint: "rgba(255, 244, 247, 0.78)",
  },
  reddit: {
    accent: "#FF4500",
    accentStrong: "#1A1A1B",
    accentText: "#8F2A00",
    accentMuted: "#A35D3E",
    buttonText: "#7A2500",
    border: "rgba(255, 69, 0, 0.32)",
    borderStrong: "rgba(26, 26, 27, 0.26)",
    ring: "rgba(255, 69, 0, 0.18)",
    panelShadow: "0 24px 60px rgba(255, 69, 0, 0.13), 0 12px 30px rgba(26, 26, 27, 0.08)",
    buttonShadow: "0 18px 36px rgba(255, 69, 0, 0.16), 0 8px 18px rgba(26, 26, 27, 0.08)",
    selectedShadow: "0 20px 38px rgba(255, 69, 0, 0.15)",
    glassEnd: "rgba(255, 247, 242, 0.76)",
    cardEnd: "rgba(255, 250, 247, 0.88)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(255,247,242,0.93) 54%, rgba(246,248,250,0.98) 100%)",
    progressGradient: "linear-gradient(90deg, #FF4500 0%, #FF9A5A 58%, #1A1A1B 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(255,69,0,0.18) 0%, rgba(255,255,255,0.96) 48%, rgba(26,26,27,0.12) 100%)",
    previewGradient: "linear-gradient(135deg, #FFD9C9 0%, #FFFFFF 52%, #E5E7EB 100%)",
    mediaTint: "rgba(255, 247, 242, 0.78)",
  },
  v2ex: {
    accent: "#5E8FDB",
    accentStrong: "#3E5F99",
    accentText: "#29476F",
    accentMuted: "#6E819E",
    buttonText: "#233C5F",
    border: "rgba(94, 143, 219, 0.32)",
    borderStrong: "rgba(62, 95, 153, 0.32)",
    ring: "rgba(94, 143, 219, 0.17)",
    panelShadow: "0 24px 60px rgba(94, 143, 219, 0.12), 0 12px 30px rgba(15, 23, 42, 0.08)",
    buttonShadow: "0 18px 36px rgba(94, 143, 219, 0.14), 0 8px 18px rgba(15, 23, 42, 0.08)",
    selectedShadow: "0 20px 38px rgba(94, 143, 219, 0.14)",
    glassEnd: "rgba(245, 249, 255, 0.76)",
    cardEnd: "rgba(248, 251, 255, 0.88)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(243,248,255,0.93) 54%, rgba(247,249,252,0.98) 100%)",
    progressGradient: "linear-gradient(90deg, #5E8FDB 0%, #AFC6E8 58%, #3E5F99 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(94,143,219,0.18) 0%, rgba(255,255,255,0.96) 48%, rgba(62,95,153,0.12) 100%)",
    previewGradient: "linear-gradient(135deg, #DDEBFF 0%, #FFFFFF 52%, #E4E9F0 100%)",
    mediaTint: "rgba(245, 249, 255, 0.78)",
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
  xiaoyuzhou: {
    accent: "#00C7B7",
    accentStrong: "#F4D84E",
    accentText: "#08756E",
    accentMuted: "#4D8E8A",
    buttonText: "#075C57",
    border: "rgba(0, 199, 183, 0.34)",
    borderStrong: "rgba(244, 216, 78, 0.42)",
    ring: "rgba(0, 199, 183, 0.18)",
    panelShadow: "0 24px 60px rgba(0, 199, 183, 0.13), 0 12px 30px rgba(17, 24, 39, 0.08)",
    buttonShadow: "0 18px 36px rgba(0, 199, 183, 0.16), 0 8px 18px rgba(244, 216, 78, 0.1)",
    selectedShadow: "0 20px 38px rgba(0, 199, 183, 0.15)",
    glassEnd: "rgba(240, 255, 253, 0.76)",
    cardEnd: "rgba(247, 255, 253, 0.88)",
    buttonGradient: "linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(237,255,253,0.93) 54%, rgba(255,250,228,0.96) 100%)",
    progressGradient: "linear-gradient(90deg, #00C7B7 0%, #8AF3EA 56%, #F4D84E 100%)",
    skeletonGradient: "linear-gradient(90deg, rgba(0,199,183,0.2) 0%, rgba(255,255,255,0.96) 48%, rgba(244,216,78,0.16) 100%)",
    previewGradient: "linear-gradient(135deg, #C9FAF5 0%, #FFFFFF 52%, #FFF3B8 100%)",
    mediaTint: "rgba(240, 255, 253, 0.78)",
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

export function SocialDownloaderClient({ appName = "LinkMigo", themeName = "default", urlPlaceholder = "", urlPlaceholderEn = "" }) {
  const [language, setLanguage] = useState("zh");
  const [colorMode, setColorMode] = useState("light");
  const [url, setUrl] = useState("");
  const [searchPlatforms, setSearchPlatforms] = useState(["xiaohongshu"]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [searchLoginPlatforms, setSearchLoginPlatforms] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [isUrlInputHovered, setIsUrlInputHovered] = useState(false);
  const [resolveProgress, setResolveProgress] = useState(null);
  const [resolvingPlatform, setResolvingPlatform] = useState("");
  const [selectedAssetIds, setSelectedAssetIds] = useState([]);
  const [selectedPostIds, setSelectedPostIds] = useState([]);
  const [isProfileDownloadPending, setIsProfileDownloadPending] = useState(false);
  const [profileDownloadJob, setProfileDownloadJob] = useState(null);
  const [isLoadingMoreProfilePosts, setIsLoadingMoreProfilePosts] = useState(false);
  const [xiaohongshuAuth, setXiaohongshuAuth] = useState({ open: false, status: "anonymous", qr_data_url: null, error: null });
  const [isPostInfoOpen, setIsPostInfoOpen] = useState(false);
  const [downloadContentsRequest, setDownloadContentsRequest] = useState(null);
  const [profilePostDetail, setProfilePostDetail] = useState({
    isOpen: false,
    isLoading: false,
    result: null,
    error: null,
    post: null,
  });
  const [postInfoInitialAssetIndex, setPostInfoInitialAssetIndex] = useState(0);
  const resolveRunRef = useRef(0);
  const profilePostsLoadingRef = useRef(false);
  const profileDownloadPollRef = useRef(null);
  const profilePostDetailRunRef = useRef(0);
  const xiaohongshuAuthPollRef = useRef(null);

  const normalizedUrl = extractUrlCandidate(url);
  const inputLooksLikeUrl = looksLikeUrlInput(url);
  const isKeywordMode = Boolean(url.trim()) && !inputLooksLikeUrl;
  const keyword = isKeywordMode ? url.trim() : "";
  const canSubmit = isKeywordMode
    ? Boolean(keyword) && searchPlatforms.length > 0
    : Boolean(normalizedUrl) && isValidHttpUrl(normalizedUrl);
  const inputPlatform = isKeywordMode ? "" : detectPlatform(normalizedUrl);
  const copy = {
    ...(copyByLanguage[language] ?? copyByLanguage.zh),
    ...(language === "zh" && urlPlaceholder ? { urlPlaceholder } : {}),
    ...(language === "en" && urlPlaceholderEn ? { urlPlaceholder: urlPlaceholderEn } : {}),
  };
  const inputTheme = getButtonTheme(inputPlatform, colorMode, themeName);
  const resolvingTheme = getButtonTheme(resolvingPlatform, colorMode, themeName);
  const resultTheme = result ? getButtonTheme(result.platform, colorMode, themeName) : getButtonTheme("", colorMode, themeName);
  const submitTheme = isLoading ? resolvingTheme : inputTheme;
  const inputDrivenTheme = normalizedUrl ? inputTheme : getButtonTheme("", colorMode, themeName);
  const hasOutput = Boolean(isLoading || result || error);
  const isProfileResult = result?.mode === "profile";
  const resultSelectionKey = result ? `${result.mode || "post"}:${result.request_id || result.canonical_url || ""}` : "";
  const selectedAssets = !isProfileResult && result
    ? result.assets.filter((asset) => selectedAssetIds.includes(asset.id))
    : [];
  const selectedPosts = isProfileResult ? result.posts.filter((post) => selectedPostIds.includes(post.id)) : [];
  const allSelected = !isProfileResult && result
    ? result.assets.length > 0 && selectedAssetIds.length === result.assets.length
    : false;
  const allPostsSelected = isProfileResult
    ? result.posts.length > 0 && selectedPostIds.length === result.posts.length
    : false;
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
    // Restore the server-side XHS session state after a refresh. This only
    // updates the login badge; it never starts a search automatically.
    fetch("/api/v1/xiaohongshu/auth/status", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (payload?.status) {
          setXiaohongshuAuth((current) => ({ ...current, ...payload, open: false }));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => () => {
    clearProfileDownloadPolling();
    if (xiaohongshuAuthPollRef.current) window.clearTimeout(xiaohongshuAuthPollRef.current);
  }, []);

  useEffect(() => {
    if (xiaohongshuAuth.status !== "authenticated") {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setXiaohongshuAuth((current) => ({ ...current, open: false }));
    }, 2_000);

    return () => window.clearTimeout(timer);
  }, [xiaohongshuAuth.status]);

  useEffect(() => {
    if (!result) {
      setSelectedAssetIds([]);
      setSelectedPostIds([]);
      setIsProfileDownloadPending(false);
      setProfileDownloadJob(null);
      clearProfileDownloadPolling();
      setIsLoadingMoreProfilePosts(false);
      profilePostsLoadingRef.current = false;
      setIsPostInfoOpen(false);
      profilePostDetailRunRef.current += 1;
      setProfilePostDetail(emptyProfilePostDetail());
      setPostInfoInitialAssetIndex(0);
      return;
    }

    if (result.mode === "profile") {
      setSelectedAssetIds([]);
      // Search results are informational by default. Let the user explicitly
      // choose posts before any future batch action.
      setSelectedPostIds([]);
      setProfileDownloadJob(null);
      clearProfileDownloadPolling();
      setIsLoadingMoreProfilePosts(false);
      profilePostsLoadingRef.current = false;
      setIsPostInfoOpen(false);
      profilePostDetailRunRef.current += 1;
      setProfilePostDetail(emptyProfilePostDetail());
      setPostInfoInitialAssetIndex(0);
      return;
    }

    setSelectedAssetIds(result.assets.map((asset) => asset.id));
    setSelectedPostIds([]);
    setProfileDownloadJob(null);
    clearProfileDownloadPolling();
    setIsLoadingMoreProfilePosts(false);
    profilePostsLoadingRef.current = false;
    profilePostDetailRunRef.current += 1;
    setProfilePostDetail(emptyProfilePostDetail());
    setPostInfoInitialAssetIndex(0);
  }, [resultSelectionKey]);

  async function onSubmit(event) {
    event?.preventDefault();

    logClientAction("resolve_button_clicked", {
      url: isKeywordMode ? keyword : normalizedUrl,
      platform: isKeywordMode ? searchPlatforms.join(",") : inputPlatform || "unknown",
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
    setSearchLoginPlatforms([]);
    setResult(null);
    setIsPostInfoOpen(false);
    setPostInfoInitialAssetIndex(0);
    setResolveProgress(createInitialResolveProgress());
    setSelectedAssetIds([]);
    setSelectedPostIds([]);
    setIsProfileDownloadPending(false);
    setIsLoadingMoreProfilePosts(false);
    profilePostsLoadingRef.current = false;

    try {
      if (isKeywordMode) {
        if (!searchPlatforms.includes("xiaohongshu")) {
          throw new Error("请选择小红书搜索平台。");
        }

        const response = await fetch("/api/v1/xiaohongshu/search", {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keyword, limit: 30 }),
        });
        const payload = await readJsonResponse(response, "小红书搜索接口没有返回有效响应");

        if (!response.ok) {
          throw payload;
        }

        const posts = Array.isArray(payload.posts) ? payload.posts : [];
        const loginPlatforms = normalizeSearchLoginPlatforms(payload.login_platforms);

        if (!posts.length) {
          throw {
            error: {
              code: payload.requires_login ? "LOGIN_REQUIRED" : "NO_MEDIA_FOUND",
              message: payload.requires_login
                ? "小红书搜索需要登录，请先完成登录后重试。"
                : "小红书没有返回相关搜索结果，可能需要登录或稍后重试。",
              details: {
                requires_login: Boolean(payload.requires_login),
                login_platforms: payload.requires_login
                  ? (loginPlatforms.length > 0 ? loginPlatforms : ["xiaohongshu"])
                  : [],
              },
            },
          };
        }

        setResult({
          mode: "profile",
          request_id: payload.request_id || "",
          platform: "xiaohongshu",
          canonical_url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}`,
          creator_handle: `search-${keyword}`,
          profile: {
            username: "search",
            full_name: `小红书搜索：${keyword}`,
            post_count: posts.length,
            follower_count: null,
            following_count: null,
          },
          posts,
          search_keyword: keyword,
          profile_posts_page: {
            total_count: posts.length,
            loaded_count: posts.length,
            next_cursor: payload.next_cursor || "",
            has_more: Boolean(payload.has_more),
            is_partial_snapshot: false,
            search_page: Number(payload.page) || 1,
            source: "xiaohongshu_search",
          },
          search_login_platforms: loginPlatforms,
        });
        setSearchLoginPlatforms(loginPlatforms);
        return;
      }

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
        const apiError = getApiError(caught);
        setError(apiError);
        if (isKeywordMode && apiError.details?.requires_login) {
          const loginPlatforms = normalizeSearchLoginPlatforms(apiError.details?.login_platforms);
          setSearchLoginPlatforms(loginPlatforms.length > 0 ? loginPlatforms : ["xiaohongshu"]);
        } else {
          setSearchLoginPlatforms([]);
        }
        const errorCode = caught?.error?.code || caught?.code;
        if (inputPlatform === "xiaohongshu" && ["LOGIN_REQUIRED", "UPSTREAM_BLOCKED"].includes(errorCode)) {
          openXiaohongshuLogin();
        }
      }
    } finally {
      if (resolveRunRef.current === runId) {
        setIsLoading(false);
        setResolveProgress(null);
      }
    }
  }

  async function openXiaohongshuLogin() {
    setXiaohongshuAuth((current) => ({ ...current, open: true, status: "pending", error: null }));
    try {
      const response = await fetch("/api/v1/xiaohongshu/auth/qr", { method: "POST", cache: "no-store" });
      const payload = await readJsonResponse(response, "二维码接口没有返回有效响应");
      setXiaohongshuAuth({ open: true, ...payload });
      pollXiaohongshuLogin();
    } catch (caught) {
      setXiaohongshuAuth({ open: true, status: "error", qr_data_url: null, error: caught?.message || "二维码生成失败" });
    }
  }

  async function pollXiaohongshuLogin() {
    if (xiaohongshuAuthPollRef.current) window.clearTimeout(xiaohongshuAuthPollRef.current);
    try {
      const response = await fetch("/api/v1/xiaohongshu/auth/status", { cache: "no-store" });
      const payload = await readJsonResponse(response, "登录状态接口没有返回有效响应");
      setXiaohongshuAuth((current) => ({ ...current, ...payload }));
      if (["pending"].includes(payload.status)) {
        xiaohongshuAuthPollRef.current = window.setTimeout(pollXiaohongshuLogin, 1500);
      }
    } catch {
      xiaohongshuAuthPollRef.current = window.setTimeout(pollXiaohongshuLogin, 2500);
    }
  }

  async function readJsonResponse(response, fallbackMessage) {
    const text = await response.text();
    if (!text.trim()) {
      throw new Error(`${fallbackMessage}（HTTP ${response.status}）`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${fallbackMessage}（HTTP ${response.status}）`);
    }
  }

  async function logoutXiaohongshu() {
    await fetch("/api/v1/xiaohongshu/auth/logout", { method: "POST", cache: "no-store" }).catch(() => {});
    setXiaohongshuAuth({ open: false, status: "anonymous", qr_data_url: null, error: null });
  }

  function openSearchLogin(platform) {
    if (platform === "xiaohongshu") {
      if (xiaohongshuAuth.status === "authenticated") {
        // Keep the current result set after login. The main Search button is
        // the explicit action that starts a new query.
        return;
      }
      openXiaohongshuLogin();
      return;
    }

    const loginUrl = keywordSearchPlatforms.find((item) => item.id === platform)?.loginUrl;
    if (loginUrl) {
      window.open(loginUrl, "_blank", "noopener,noreferrer");
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

  function clearProfileDownloadPolling() {
    if (profileDownloadPollRef.current) {
      window.clearTimeout(profileDownloadPollRef.current);
      profileDownloadPollRef.current = null;
    }
  }

  function reset() {
    logClientAction("reset_button_clicked", {
      had_url: Boolean(url.trim()),
      had_result: Boolean(result),
      had_error: Boolean(error),
    });

    resolveRunRef.current += 1;
    setUrl("");
    setSearchPlatforms(["xiaohongshu"]);
    setSearchLoginPlatforms([]);
    setResult(null);
    setError(null);
    setIsLoading(false);
    setIsPostInfoOpen(false);
    setPostInfoInitialAssetIndex(0);
    setIsInputFocused(false);
    setIsUrlInputHovered(false);
    setResolveProgress(null);
    setResolvingPlatform("");
    setSelectedAssetIds([]);
    setSelectedPostIds([]);
    setIsProfileDownloadPending(false);
    setProfileDownloadJob(null);
    clearProfileDownloadPolling();
    setIsLoadingMoreProfilePosts(false);
    profilePostsLoadingRef.current = false;
    profilePostDetailRunRef.current += 1;
    setProfilePostDetail(emptyProfilePostDetail());
  }

  function clearUrl() {
    logClientAction("url_clear_clicked", {
      had_url: Boolean(url.trim()),
      platform: inputPlatform || "unknown",
    });

    setUrl("");
    setSearchPlatforms(["xiaohongshu"]);
    setSearchLoginPlatforms([]);
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

  function toggleProfilePost(postId) {
    setSelectedPostIds((current) => {
      const isSelected = current.includes(postId);
      const next = isSelected
        ? current.filter((id) => id !== postId)
        : [...current, postId];

      logClientAction("profile_post_selection_toggled", {
        post_id: postId,
        selected: !isSelected,
        selected_count: next.length,
        request_id: result?.request_id,
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

  function toggleAllProfilePosts() {
    if (!isProfileResult) {
      return;
    }

    const next = allPostsSelected ? [] : result.posts.map((post) => post.id);

    logClientAction("profile_post_select_all_toggled", {
      selected_all: !allPostsSelected,
      selected_count: next.length,
      post_count: result.posts.length,
      request_id: result.request_id,
    });

    setSelectedPostIds(next);
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

  function invertProfileSelection() {
    if (!isProfileResult) {
      return;
    }

    setSelectedPostIds((current) => {
      const next = result.posts
        .map((post) => post.id)
        .filter((postId) => !current.includes(postId));

      logClientAction("profile_post_selection_inverted", {
        selected_count: next.length,
        post_count: result.posts.length,
        request_id: result.request_id,
      });

      return next;
    });
  }

  async function loadMoreProfilePosts() {
    if (!isProfileResult || profilePostsLoadingRef.current) {
      return;
    }

    const page = result.profile_posts_page ?? {};
    const canTryPartialSnapshot = Boolean(page.is_partial_snapshot && result.posts.length < (Number(page.total_count) || result.posts.length + 1));
    const cursor = page.next_cursor || (canTryPartialSnapshot ? String(result.posts.length) : "");

    if ((!page.has_more && !canTryPartialSnapshot) || !cursor) {
      return;
    }

    const shouldSelectNewPosts = allPostsSelected;
    const isXiaohongshuSearch = result.platform === "xiaohongshu"
      && Boolean(result.search_keyword)
      && page.source === "xiaohongshu_search";
    const nextSearchPage = Math.max(Number.parseInt(page.search_page, 10) || 1, 1) + 1;

    profilePostsLoadingRef.current = true;
    setIsLoadingMoreProfilePosts(true);
    setError(null);

    try {
      const response = isXiaohongshuSearch
        ? await fetch("/api/v1/xiaohongshu/search", {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            keyword: result.search_keyword,
            limit: 20,
            page: nextSearchPage,
            cursor,
            request_id: result.request_id,
          }),
        })
        : await fetch(
          `/api/v1/instagram/profile-requests/${encodeURIComponent(result.request_id)}/posts?cursor=${encodeURIComponent(cursor)}&limit=30`,
          { cache: "no-store" },
        );
      const payload = await response.json();

      if (!response.ok) {
        throw payload;
      }

      const nextPosts = normalizeProfilePostList(payload.posts);

      setResult((current) => {
        if (current?.mode !== "profile" || current.request_id !== result.request_id) {
          return current;
        }

        const mergedPosts = mergeProfilePosts(current.posts, nextPosts);
        return {
          ...current,
          posts: mergedPosts,
          profile: isXiaohongshuSearch
            ? { ...current.profile, post_count: mergedPosts.length }
            : current.profile,
          profile_posts_page: isXiaohongshuSearch
            ? {
              total_count: mergedPosts.length,
              loaded_count: mergedPosts.length,
              next_cursor: payload.next_cursor || "",
              has_more: Boolean(payload.has_more && payload.next_cursor && nextPosts.length > 0),
              is_partial_snapshot: false,
              search_page: Number(payload.page) || nextSearchPage,
              source: "xiaohongshu_search",
            }
            : payload.page ?? current.profile_posts_page,
        };
      });

      if (shouldSelectNewPosts) {
        setSelectedPostIds((current) => mergeUniqueIds(current, nextPosts.map((post) => post.id)));
      }
    } catch (caught) {
      // 保留已经展示的帖子；分页失败不应把整个主页结果替换成错误页。
      console.warn("加载主页下一页帖子失败", caught);
    } finally {
      profilePostsLoadingRef.current = false;
      setIsLoadingMoreProfilePosts(false);
    }
  }

  function onProfilePostsScroll(event) {
    const viewport = event.currentTarget;
    const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;

    if (remaining < 180) {
      loadMoreProfilePosts();
    }
  }

  function openPostInfoModal(assetIndex = 0) {
    const assetCount = result?.assets?.length ?? 0;

    setPostInfoInitialAssetIndex(clampAssetIndex(assetIndex, assetCount));
    setIsPostInfoOpen(true);
  }

  async function openProfilePostDetail(post) {
    if (!post?.canonical_url) {
      return;
    }

    const runId = profilePostDetailRunRef.current + 1;

    profilePostDetailRunRef.current = runId;
    setProfilePostDetail({
      isOpen: true,
      isLoading: true,
      result: null,
      error: null,
      post,
    });

    logClientAction("profile_post_detail_clicked", {
      request_id: result?.request_id,
      post_id: post.id,
      canonical_url: post.canonical_url,
    });

    try {
      const response = await fetch("/api/v1/instagram/resolve/jobs", {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: post.canonical_url }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw payload;
      }

      const immediateResult = profilePostDetailPayloadResult(payload);
      const detailResult = immediateResult || await pollProfilePostDetailJob(payload.job_id, runId);

      if (profilePostDetailRunRef.current !== runId) {
        return;
      }

      setProfilePostDetail({
        isOpen: true,
        isLoading: false,
        result: detailResult,
        error: null,
        post,
      });
    } catch (caught) {
      if (profilePostDetailRunRef.current !== runId) {
        return;
      }

      setProfilePostDetail({
        isOpen: true,
        isLoading: false,
        result: null,
        error: getApiError(caught),
        post,
      });
    }
  }

  async function pollProfilePostDetailJob(jobId, runId) {
    if (!jobId) {
      throw new Error("帖子详情任务创建失败，请稍后重试。");
    }

    let delayMs = 250;

    while (profilePostDetailRunRef.current === runId) {
      await sleep(delayMs);
      delayMs = 600;

      const response = await fetch(`/api/v1/instagram/resolve/jobs/${encodeURIComponent(jobId)}`, {
        cache: "no-store",
      });
      const payload = await response.json();

      if (!response.ok) {
        throw payload;
      }

      const resultPayload = profilePostDetailPayloadResult(payload);

      if (resultPayload) {
        return resultPayload;
      }

      if (payload?.status === "failed") {
        throw { error: payload.error };
      }
    }

    return null;
  }

  function closeProfilePostDetail() {
    profilePostDetailRunRef.current += 1;
    setProfilePostDetail(emptyProfilePostDetail());
  }

  function downloadCurrentAsset(asset) {
    if (!asset) {
      return;
    }

    logClientAction("preview_asset_download_clicked", {
      asset_id: asset.id,
      filename: asset.filename,
      media_type: asset.media_type,
      download_url: asset.download_url,
      source: "post_info_modal",
    });

    triggerBrowserDownload(apiUrl(asset.download_url));
  }

  function startPostDownload(targetResult, options, source = "post_info_modal") {
    if (!targetResult?.request_id) {
      return;
    }

    const params = new URLSearchParams();
    params.set("include_media", options.includeMedia ? "1" : "0");
    params.set("include_post_text", options.includePostText ? "1" : "0");
    params.set("include_comments", options.includeComments ? "1" : "0");
    if (options.includeComments) params.set("comment_limit", String(options.commentLimit));
    if (options.assetIds?.length) params.set("asset_ids", options.assetIds.join(","));

    logClientAction("bulk_asset_download_clicked", {
      request_id: targetResult.request_id,
      platform: targetResult.platform,
      shortcode: targetResult.shortcode,
      selected_asset_ids: options.assetIds || [],
      selected_count: options.assetIds?.length || 0,
      include_media: options.includeMedia,
      include_post_text: options.includePostText,
      include_comments: options.includeComments,
      comment_limit: options.includeComments ? options.commentLimit : null,
      source,
    });

    triggerBrowserDownload(apiUrl(`/api/v1/instagram/requests/${targetResult.request_id}/download.zip?${params.toString()}`));
  }

  function openDownloadContents(targetResult, assetIds, source = "post_info_modal") {
    if (!targetResult?.request_id) return;

    setDownloadContentsRequest({
      targetResult,
      assetIds: Array.isArray(assetIds) ? assetIds : [],
      source,
    });
  }

  function downloadAllAssets() {
    if (!result || result.assets.length === 0) return;

    if (result.platform === "xiaohongshu") {
      openDownloadContents(result, result.assets.map((asset) => asset.id));
      return;
    }

    triggerBrowserDownload(apiUrl(`/api/v1/instagram/requests/${result.request_id}/download.zip`));
  }

  function downloadAllAssetsFromResult(targetResult, source = "post_info_modal") {
    if (!targetResult || !Array.isArray(targetResult.assets) || targetResult.assets.length === 0) {
      return;
    }

    if (targetResult.platform === "xiaohongshu") {
      openDownloadContents(targetResult, targetResult.assets.map((asset) => asset.id), source);
      return;
    }

    triggerBrowserDownload(apiUrl(`/api/v1/instagram/requests/${targetResult.request_id}/download.zip`));
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

    if (result.platform === "xiaohongshu") {
      openDownloadContents(result, selectedAssets.map((asset) => asset.id), "result_selection");
      return;
    }

    if (selectedAssets.length === 1) {
      triggerBrowserDownload(apiUrl(selectedAssets[0].download_url));
      return;
    }

    const assetIds = selectedAssets.map((asset) => asset.id).join(",");
    const zipUrl = `/api/v1/instagram/requests/${result.request_id}/download.zip?asset_ids=${encodeURIComponent(assetIds)}`;

    triggerBrowserDownload(apiUrl(zipUrl));
  }

  function downloadSelectedPosts() {
    if (!isProfileResult || !result?.request_id || selectedPosts.length === 0 || isProfileDownloadPending) {
      return;
    }

    if (result.platform === "xiaohongshu") {
      setDownloadContentsRequest({
        kind: "profile",
        targetResult: result,
        postIds: selectedPosts.map((post) => post.id),
        source: "profile_selection",
      });
      return;
    }

    startSelectedPostsDownload({ includeMedia: true, includePostText: false, includeComments: false, commentLimit: 20 });
  }

  async function startSelectedPostsDownload(downloadOptions, postIds = selectedPosts.map((post) => post.id)) {
    if (!isProfileResult || !result?.request_id || postIds.length === 0 || isProfileDownloadPending) {
      return;
    }

    setIsProfileDownloadPending(true);
    setProfileDownloadJob(createLocalProfileDownloadJob(result.posts.filter((post) => postIds.includes(post.id))));
    setError(null);

    logClientAction("profile_post_download_clicked", {
      request_id: result.request_id,
      creator_handle: result.creator_handle,
      selected_post_ids: postIds,
      selected_count: postIds.length,
      include_media: downloadOptions.includeMedia,
      include_post_text: downloadOptions.includePostText,
      include_comments: downloadOptions.includeComments,
      comment_limit: downloadOptions.includeComments ? downloadOptions.commentLimit : null,
    });

    try {
      const response = await fetch(`/api/v1/instagram/profile-requests/${encodeURIComponent(result.request_id)}/download-jobs`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          post_ids: postIds,
          include_media: downloadOptions.includeMedia,
          include_post_text: downloadOptions.includePostText,
          include_comments: downloadOptions.includeComments,
          comment_limit: downloadOptions.commentLimit,
        }),
      });

      if (!response.ok) {
        let payload = null;

        try {
          payload = await response.json();
        } catch {
          payload = null;
        }

        throw payload || new Error("Download failed");
      }

      const payload = await response.json();

      setProfileDownloadJob(payload);
      pollProfileDownloadJob(payload.job_id, result.request_id);
    } catch (caught) {
      setError(getApiError(caught));
      setIsProfileDownloadPending(false);
    }
  }

  async function pollProfileDownloadJob(jobId, requestId) {
    if (!jobId || !requestId) {
      setIsProfileDownloadPending(false);
      return;
    }

    clearProfileDownloadPolling();

    try {
      const response = await fetch(
        `/api/v1/instagram/profile-requests/${encodeURIComponent(requestId)}/download-jobs/${encodeURIComponent(jobId)}`,
        { cache: "no-store" },
      );
      const payload = await response.json();

      if (!response.ok) {
        throw payload;
      }

      setProfileDownloadJob(payload);

      if (payload.status === "completed") {
        setIsProfileDownloadPending(false);

        if (payload.result?.download_url) {
          triggerBrowserDownload(apiUrl(payload.result.download_url));
        }

        return;
      }

      if (payload.status === "failed") {
        setIsProfileDownloadPending(false);
        setError(getApiError({ error: payload.error }));
        return;
      }

      profileDownloadPollRef.current = window.setTimeout(() => {
        pollProfileDownloadJob(jobId, requestId);
      }, 700);
    } catch (caught) {
      setIsProfileDownloadPending(false);
      setError(getApiError(caught));
    }
  }

  const formStyle = buildSearchShellStyle(
    inputTheme,
    isInputFocused,
    normalizedUrl && !canSubmit,
  );
  const isCohereTheme = themeName === "cohere";
  const searchButtonStyle = buildPrimaryButtonStyle(submitTheme, !canSubmit || isLoading);
  const resetButtonStyle = buildSecondaryButtonStyle(inputDrivenTheme);
  const resultSecondaryButtonStyle = buildSecondaryButtonStyle(resultTheme);

  return (
    <main
      className="lm-page relative h-[100svh] overflow-hidden transition-colors duration-700"
      data-color-mode={colorMode}
      data-ui-theme={themeName}
      style={{ backgroundColor: inputDrivenTheme.pageBackground, color: inputDrivenTheme.pageText }}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 transition-[background] duration-700" style={{ background: inputDrivenTheme.pageBackdrop }} />
        <div className="absolute left-[-12%] top-[-8%] h-[32rem] w-[32rem] rounded-full blur-[90px] transition-colors duration-700" style={{ backgroundColor: inputDrivenTheme.glowA }} />
        <div className="absolute right-[-8%] top-[6%] h-[28rem] w-[28rem] rounded-full blur-[90px] transition-colors duration-700" style={{ backgroundColor: inputDrivenTheme.glowB }} />
        <div className="absolute bottom-[-14%] left-[18%] h-[20rem] w-[20rem] rounded-full blur-[80px] transition-colors duration-700" style={{ backgroundColor: inputDrivenTheme.glowC }} />
      </div>

      <section className={`relative mx-auto flex h-full w-full max-w-[1480px] flex-col overflow-hidden px-3 py-4 sm:px-7 sm:py-6 lg:px-10 ${isCohereTheme ? "lg:mx-0 lg:max-w-none lg:grid lg:grid-cols-[minmax(19rem,23rem)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:gap-x-6 lg:px-0 lg:py-3 lg:pr-12" : ""}`}>
        <PreferenceControls
          colorMode={colorMode}
          copy={copy}
          isCohereTheme={isCohereTheme}
          language={language}
          onColorModeChange={setColorMode}
          onLanguageChange={setLanguage}
          theme={inputDrivenTheme}
        />

        <div
          className={`mx-auto w-full max-w-6xl pb-3 pt-0 transition-transform duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform ${isCohereTheme ? "lg:col-start-1 lg:row-start-1 lg:row-span-1 lg:mx-0 lg:flex lg:min-h-0 lg:max-w-none lg:flex-col lg:pb-0 lg:pt-0" : ""}`}
          style={{ transform: isCohereTheme || hasOutput ? "translate3d(0,0,0)" : "translate3d(0, clamp(2.75rem, 11svh, 7.5rem), 0)" }}
        >
          <div className={`relative ${isCohereTheme ? "flex min-h-0 flex-1 flex-col rounded-[1.5rem] border p-4 sm:p-5 lg:rounded-[1.75rem]" : hasOutput ? "pt-12 sm:pt-14" : "pt-20 sm:pt-24 lg:pt-28"}`} style={isCohereTheme ? buildCohereSidebarStyle(inputDrivenTheme) : undefined}>
            {!isCohereTheme ? (
              <MediaStack compact={hasOutput} mutedDarkPlayIcon={colorMode === "dark" && !normalizedUrl} theme={inputDrivenTheme} />
            ) : null}

            <div className="relative z-10">
              <div className={isCohereTheme ? "text-left" : "text-center"}>
                <h1
                  className={`${themeName === "cohere" ? "font-sans not-italic tracking-[-0.06em]" : "font-serif italic"} leading-[0.98] transition-all duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                    isCohereTheme ? "text-[2.6rem] sm:text-[3.2rem] lg:text-[3.65rem]" : hasOutput ? "text-[2rem] sm:text-[2.75rem]" : "text-[3.2rem] sm:text-[5.4rem] lg:text-[6.25rem]"
                  }`}
                  style={{ color: inputDrivenTheme.titleText }}
                >
                  {appName}
                </h1>
                <p
                  className={`${isCohereTheme ? "max-w-[18rem]" : "mx-auto max-w-2xl"} overflow-hidden transition-all duration-500 ${
                    isCohereTheme ? "mt-3 max-h-20 text-sm opacity-100 sm:text-base" : hasOutput ? "mt-1 max-h-0 text-sm opacity-0" : "mt-4 max-h-14 text-base opacity-100 sm:text-lg"
                  }`}
                  style={{ color: inputDrivenTheme.mutedText }}
                >
                  {copy.subtitle}
                </p>
              </div>

              <form
                noValidate
                className={`${isCohereTheme
                  ? "mt-7 rounded-[1.25rem] p-3.5 sm:p-4"
                  : `mx-auto max-w-6xl ${hasOutput ? "mt-4 rounded-[1.5rem] p-3 sm:p-4" : "mt-6 rounded-[2rem] p-4 sm:p-5"}`
                } w-full transition-all duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${glassPanelClass} ${inputDrivenTheme.panelClass}`}
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
                      isCohereTheme ? "h-12 sm:h-14" : hasOutput ? "h-11 sm:h-12" : "h-14 sm:h-16"
                    }`}
                    id="social-url"
                    inputMode={isKeywordMode ? "search" : "url"}
                    name="social-url"
                    onBlur={() => setIsInputFocused(false)}
                    onChange={onUrlChange}
                    onFocus={() => setIsInputFocused(true)}
                    placeholder={isKeywordMode ? (language === "zh" ? "输入关键词，选择平台后搜索..." : "Enter a keyword, then choose platforms to search...") : copy.urlPlaceholder}
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
                      className={`lm-themed-action ${isCohereTheme ? "lm-cohere-contrast-hover" : ""} absolute right-0 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full border transition-[background-color,border-color,box-shadow,color,opacity,transform] duration-300 ease-out ${
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

                {isKeywordMode && !isCohereTheme ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: inputDrivenTheme.panelBorder }}>
                    <span className="mr-1 text-xs font-semibold" style={{ color: inputDrivenTheme.mutedText }}>
                      {copy.searchPlatform}
                    </span>
                    {keywordSearchPlatforms.map((platform) => {
                      const isSelected = searchPlatforms.includes(platform.id);
                      const label = getPlatformLabel(platform.id, copy);

                      return (
                        <button
                          aria-disabled={!platform.enabled}
                          aria-pressed={isSelected}
                          className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[13px] font-semibold transition ${platform.enabled ? "" : "cursor-not-allowed opacity-60"}`}
                          disabled={!platform.enabled}
                          key={platform.id}
                          onClick={() => setSearchPlatforms((current) => current.includes(platform.id) ? current.filter((item) => item !== platform.id) : [...current, platform.id])}
                          style={isSelected ? buildPrimaryButtonStyle(inputDrivenTheme, false) : buildSecondaryButtonStyle(inputDrivenTheme)}
                          title={platform.enabled ? label : `${label} · ${copy.comingSoon}`}
                          type="button"
                        >
                          <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: platform.color }} />
                          {label}
                          {!platform.enabled ? <span className="text-[10px] font-medium opacity-80">{copy.comingSoon}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                <div className={`mt-3 flex flex-col gap-3 ${isCohereTheme ? "items-stretch" : "sm:flex-row sm:flex-nowrap sm:items-center"}`}>
                  {!isCohereTheme && !isKeywordMode && inputPlatform === "xiaohongshu" ? (
                    <button
                      className={`${actionButtonBaseClass} lm-cohere-contrast-hover h-11 shrink-0 px-4 text-[13px] ${isCohereTheme ? "w-full rounded-lg" : ""}`}
                      onClick={openXiaohongshuLogin}
                      style={buildSecondaryButtonStyle(inputDrivenTheme)}
                      type="button"
                    >
                      {xiaohongshuAuth.status === "authenticated" ? "小红书已登录" : "小红书扫码登录"}
                    </button>
                  ) : null}

                  {result ? (
                    <button
                      className={`${actionButtonBaseClass} lm-cohere-contrast-hover ${isCohereTheme ? "w-full rounded-lg" : ""}`}
                      onClick={reset}
                      style={resetButtonStyle}
                      type="button"
                    >
                      {copy.reset}
                    </button>
                  ) : null}

                  {!isKeywordMode && normalizedUrl && !canSubmit ? (
                    <span id="social-url-error" className="text-sm font-medium" style={{ color: inputDrivenTheme.invalidText }}>
                      {copy.invalidUrl}
                    </span>
                  ) : null}

                  <div className={`flex w-full items-center gap-2 ${isCohereTheme ? "" : "sm:ml-auto sm:w-auto"}`}>
                    <button
                      className={`${actionButtonBaseClass} h-11 w-full min-w-[6rem] px-6 ${isCohereTheme ? "rounded-lg" : "sm:w-auto"}`}
                      disabled={!canSubmit || isLoading}
                      style={searchButtonStyle}
                      type="submit"
                    >
                      {isLoading ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="block size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                          {isKeywordMode ? (language === "zh" ? "搜索中..." : "Searching...") : copy.parsing}
                        </span>
                      ) : (
                        copy.search
                      )}
                    </button>
                  </div>
                </div>
              </form>

              {isKeywordMode && isCohereTheme ? (
                <div className="mt-3 px-1">
                  <span className="block text-xs font-semibold" style={{ color: inputDrivenTheme.mutedText }}>
                    {copy.searchPlatform}
                  </span>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {keywordSearchPlatforms.map((platform) => {
                      const isSelected = searchPlatforms.includes(platform.id);
                      const label = getPlatformLabel(platform.id, copy);

                      return (
                        <button
                          aria-disabled={!platform.enabled}
                          aria-pressed={isSelected}
                          className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-[13px] font-semibold transition ${platform.enabled ? "" : "cursor-not-allowed opacity-60"}`}
                          disabled={!platform.enabled}
                          key={platform.id}
                          onClick={() => setSearchPlatforms((current) => current.includes(platform.id) ? current.filter((item) => item !== platform.id) : [...current, platform.id])}
                          style={isSelected ? buildPrimaryButtonStyle(inputDrivenTheme, false) : buildSecondaryButtonStyle(inputDrivenTheme)}
                          title={platform.enabled ? label : `${label} · ${copy.comingSoon}`}
                          type="button"
                        >
                          <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: platform.color }} />
                          {label}
                          {!platform.enabled ? <span className="text-[10px] font-medium opacity-80">{copy.comingSoon}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>

            {isCohereTheme && !isKeywordMode && inputPlatform === "xiaohongshu" ? (
              <div className="mt-auto flex justify-end pt-6">
                <button
                  className={`${actionButtonBaseClass} lm-cohere-contrast-hover h-11 rounded-lg px-4 text-[13px]`}
                  onClick={openXiaohongshuLogin}
                  style={buildSecondaryButtonStyle(inputDrivenTheme)}
                  type="button"
                >
                  {xiaohongshuAuth.status === "authenticated" ? "小红书已登录" : "小红书扫码登录"}
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div
          className={`mx-auto flex min-h-0 w-full max-w-6xl flex-1 transition-all duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            hasOutput ? "mt-4 translate-y-0 opacity-100" : isCohereTheme ? "mt-0 translate-y-0 opacity-100" : "pointer-events-none mt-0 translate-y-6 opacity-0"
          } ${isCohereTheme ? "lg:col-start-2 lg:row-start-1 lg:mx-0 lg:max-w-none lg:pt-14" : ""}`}
        >
          {!hasOutput && isCohereTheme ? <CohereEmptyState copy={copy} theme={inputDrivenTheme} /> : null}
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
                {isKeywordMode && searchLoginPlatforms.length > 0 ? (
                  <div className="mt-3 grid gap-2">
                    <strong className="text-sm" style={{ color: inputDrivenTheme.accentText }}>{copy.searchLoginTitle}</strong>
                    <span className="text-xs font-semibold" style={{ color: inputDrivenTheme.mutedText }}>
                      {copy.searchLoginHint}
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {searchLoginPlatforms.map((platform) => (
                        <button
                          className={`${actionButtonBaseClass} h-9 px-3 text-[13px]`}
                          key={platform}
                          onClick={() => openSearchLogin(platform)}
                          style={buildPrimaryButtonStyle(inputDrivenTheme, false)}
                          type="button"
                        >
                          <span aria-hidden="true" className="mr-1.5 inline-block size-2 rounded-full" style={{ backgroundColor: keywordSearchPlatforms.find((item) => item.id === platform)?.color || inputDrivenTheme.accent }} />
                          {getPlatformLabel(platform, copy)} {platform === "xiaohongshu" && xiaohongshuAuth.status === "authenticated" ? copy.searchRetryButton : copy.searchLoginButton}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {isLoading ? <ResolvingState copy={copy} language={language} progress={resolveProgress} theme={resolvingTheme} /> : null}

          {result ? (
            isProfileResult ? (
              <ProfileResultSection
                allSelected={allPostsSelected}
                copy={copy}
                expiryText={expiryText}
                isDownloading={isProfileDownloadPending}
                isLoadingMore={isLoadingMoreProfilePosts}
                language={language}
                onDownloadSelected={downloadSelectedPosts}
                onOpenPostDetail={openProfilePostDetail}
                onInvertSelection={invertProfileSelection}
                onPostsScroll={onProfilePostsScroll}
                onToggleAll={toggleAllProfilePosts}
                onTogglePost={toggleProfilePost}
                onLoginPlatform={openSearchLogin}
                profileDownloadJob={profileDownloadJob}
                result={result}
                searchLoginPlatforms={searchLoginPlatforms}
                isXiaohongshuAuthenticated={xiaohongshuAuth.status === "authenticated"}
                selectedPostIds={selectedPostIds}
                selectedPosts={selectedPosts}
                theme={resultTheme}
              />
            ) : (
              <section className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-[2rem] border backdrop-blur-[28px]" style={buildResultShellStyle(resultTheme)} aria-label={copy.resultAria}>
                <div className="grid shrink-0 gap-2 border-b px-3 pb-2 pt-3 sm:px-5 min-[600px]:grid-cols-[minmax(0,1fr)_auto] min-[600px]:items-center" style={{ borderColor: resultTheme.panelBorder }}>
                  <div className="lm-inline-scroll -mt-1 flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto pb-2 pt-1">
                    <GlassChip theme={resultTheme}>{getPlatformLabel(result.platform, copy)}</GlassChip>
                    <a
                      className="lm-themed-action lm-cohere-contrast-hover lm-cohere-flat-action inline-flex h-9 max-w-full shrink-0 cursor-pointer items-center rounded-full border px-3 text-[13px] font-semibold transition"
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
                    <div className="justify-self-start min-[600px]:justify-self-end">
                      <GlassChip alignRight theme={resultTheme}>
                        {copy.expiredAt} {expiryText}
                      </GlassChip>
                    </div>
                  ) : null}
                </div>

                <div className="grid shrink-0 gap-2 border-b px-3 py-2 sm:px-5 min-[600px]:grid-cols-[minmax(0,1fr)_auto] min-[600px]:items-start" style={{ borderColor: resultTheme.panelBorder }}>
                  <div className="lm-inline-scroll flex min-w-0 flex-wrap items-center gap-2 overflow-visible min-[600px]:flex-nowrap min-[600px]:overflow-x-auto">
                    <button
                      className="lm-themed-action lm-cohere-contrast-hover lm-cohere-flat-action mr-1 inline-flex h-10 max-w-full shrink-0 cursor-pointer items-center gap-2 rounded-full border px-3 text-left text-sm font-semibold transition sm:text-base"
                      onClick={() => openPostInfoModal(0)}
                      style={buildCreatorButtonStyle(resultTheme)}
                      title={copy.openPostDetails}
                      type="button"
                    >
                      <span className="truncate">{creatorLabel}</span>
                      <span className="grid size-5 shrink-0 place-items-center rounded-full border text-[11px]" style={buildInfoBadgeStyle(resultTheme)}>
                        <InfoIcon />
                      </span>
                    </button>
                    {createMetricItems(result.metrics, copy).map((item) => (
                      <StatPill key={item.key} label={item.label} language={language} theme={resultTheme} value={item.value} />
                    ))}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2 min-[600px]:flex-nowrap min-[600px]:justify-end">
                    <button className={`${actionButtonBaseClass} lm-cohere-contrast-hover h-9 px-3 text-[13px]`} onClick={toggleAll} style={resultSecondaryButtonStyle} type="button">
                      {allSelected ? copy.none : copy.all}
                    </button>
                    <button className={`${actionButtonBaseClass} lm-cohere-contrast-hover h-9 px-3 text-[13px]`} onClick={invertSelection} style={resultSecondaryButtonStyle} type="button">
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
                    onPreviewAsset={openPostInfoModal}
                    onToggleAsset={toggleAsset}
                    selectedAssetIds={selectedAssetIds}
                    theme={resultTheme}
                    colorMode={colorMode}
                    language={language}
                    labels={copy}
                  />
                </FloatingScrollArea>
              </section>
            )
          ) : null}
        </div>
      </section>

      {xiaohongshuAuth.open ? (
        <XiaohongshuLoginModal
          auth={xiaohongshuAuth}
          onClose={() => setXiaohongshuAuth((current) => ({ ...current, open: false }))}
          onLogout={logoutXiaohongshu}
          onRetry={openXiaohongshuLogin}
          theme={inputDrivenTheme}
        />
      ) : null}

      {result && isPostInfoOpen ? (
        <PostInfoModal
          copy={copy}
          initialAssetIndex={postInfoInitialAssetIndex}
          language={language}
          onClose={() => setIsPostInfoOpen(false)}
          onDownloadAll={downloadAllAssets}
          onDownloadAsset={downloadCurrentAsset}
          result={result}
          theme={resultTheme}
        />
      ) : null}
      {downloadContentsRequest ? (
        <DownloadContentsModal
          copy={copy}
          onClose={() => setDownloadContentsRequest(null)}
          onDownload={(options) => {
            const request = downloadContentsRequest;
            setDownloadContentsRequest(null);
            if (request.kind === "profile") {
              startSelectedPostsDownload(options, request.postIds);
              return;
            }
            if (request.source === "result_selection" && options.includeMedia && !options.includePostText && !options.includeComments && request.assetIds.length === 1) {
              const asset = request.targetResult.assets.find((item) => item.id === request.assetIds[0]);
              if (asset) {
                triggerBrowserDownload(apiUrl(asset.download_url));
                return;
              }
            }
            startPostDownload(request.targetResult, { ...options, assetIds: request.assetIds }, request.source);
          }}
          result={downloadContentsRequest.targetResult}
          theme={getButtonTheme(downloadContentsRequest.targetResult.platform, colorMode, themeName)}
        />
      ) : null}
      {profilePostDetail.isOpen && profilePostDetail.result ? (
        <PostInfoModal
          copy={copy}
          initialAssetIndex={0}
          language={language}
          onClose={closeProfilePostDetail}
          onDownloadAll={() => downloadAllAssetsFromResult(profilePostDetail.result, "profile_post_detail_modal")}
          onDownloadAsset={downloadCurrentAsset}
          result={profilePostDetail.result}
          theme={getButtonTheme(profilePostDetail.result.platform, colorMode, themeName)}
        />
      ) : null}
      {profilePostDetail.isOpen && !profilePostDetail.result ? (
        <ProfilePostDetailStatusModal
          copy={copy}
          error={profilePostDetail.error}
          isLoading={profilePostDetail.isLoading}
          language={language}
          onClose={closeProfilePostDetail}
          onRetry={() => openProfilePostDetail(profilePostDetail.post)}
          theme={resultTheme}
        />
      ) : null}
    </main>
  );
}

function XiaohongshuLoginModal({ auth, onClose, onRetry, onLogout, theme }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 px-5 backdrop-blur-xl" onMouseDown={onClose} role="presentation">
      <section className="grid w-[min(92vw,28rem)] gap-5 rounded-[1.5rem] border p-6 shadow-2xl" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" style={buildResultShellStyle(theme)}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold" style={{ color: theme.titleText }}>小红书扫码登录</h2>
            <p className="mt-1 text-sm" style={{ color: theme.mutedText }}>
              使用小红书 App 扫描二维码。登录状态只绑定当前浏览器。
            </p>
          </div>
          <button className="grid size-8 place-items-center rounded-full border" onClick={onClose} style={buildSecondaryButtonStyle(theme)} type="button">×</button>
        </div>
        {auth.qr_data_url ? <img alt="小红书登录二维码" className="mx-auto aspect-square w-64 rounded-xl border bg-white object-contain p-2" src={auth.qr_data_url} /> : null}
        <div className="text-center text-sm font-semibold" style={{ color: theme.mutedText }}>
          {auth.status === "authenticated" ? "登录成功，可以开始解析。" : auth.status === "expired" ? "二维码已过期，请重新生成。" : auth.status === "error" ? auth.error || "二维码生成失败。" : "等待扫码确认…"}
        </div>
        {auth.status === "authenticated" ? <button className={`${actionButtonBaseClass} h-10 px-4 text-sm`} onClick={onLogout} style={buildSecondaryButtonStyle(theme)} type="button">退出小红书登录</button> : <button className={`${actionButtonBaseClass} h-10 px-4 text-sm`} onClick={onRetry} style={buildPrimaryButtonStyle(theme, false)} type="button">重新生成二维码</button>}
      </section>
    </div>
  );
}

function ProfilePostDetailStatusModal({ copy, error, isLoading, language, onClose, onRetry, theme }) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center px-6 py-6 backdrop-blur-[18px]"
      onMouseDown={onClose}
      role="presentation"
      style={buildPostModalBackdropStyle(theme)}
    >
      <section
        aria-label={copy.postDetails}
        aria-modal="true"
        className="grid w-[min(92vw,28rem)] gap-5 rounded-[1.3rem] border p-5 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        style={buildResultShellStyle(theme)}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="grid gap-1">
            <div className="text-base font-bold" style={{ color: theme.titleText }}>
              {copy.postDetails}
            </div>
            <div className="text-sm font-medium" style={{ color: theme.mutedText }}>
              {isLoading ? copy.loadingPostDetails : error?.message || errorLabel(error || {}, language)}
            </div>
          </div>
          <button
            aria-label={copy.closeDetails}
            className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border"
            onClick={onClose}
            style={buildSecondaryButtonStyle(theme)}
            type="button"
          >
            <ClearIcon />
          </button>
        </div>

        {isLoading ? (
          <div className="mc-skeleton h-2 overflow-hidden rounded-full" style={buildSkeletonStyle(theme)} />
        ) : (
          <div className="flex justify-end gap-2">
            <button className={`${actionButtonBaseClass} h-9 px-4 text-[13px]`} onClick={onRetry} style={buildPrimaryButtonStyle(theme, false)} type="button">
              {copy.retry}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function ProfileResultSection({
  allSelected,
  copy,
  expiryText,
  isDownloading,
  isLoadingMore,
  language,
  onDownloadSelected,
  onInvertSelection,
  onOpenPostDetail,
  onPostsScroll,
  onToggleAll,
  onTogglePost,
  onLoginPlatform,
  profileDownloadJob,
  result,
  searchLoginPlatforms,
  isXiaohongshuAuthenticated,
  selectedPostIds,
  selectedPosts,
  theme,
}) {
  const profile = result.profile ?? {};
  const page = result.profile_posts_page ?? {};
  const statItems = createProfileMetricItems(profile, copy);
  const avatarUrl = profileImageUrl(profile.avatar_url, result.platform, "avatar");
  const totalPosts = Math.max(Number(page.total_count) || 0, result.posts.length);

  return (
    <section className="flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-[2rem] border backdrop-blur-[28px]" style={buildResultShellStyle(theme)} aria-label={copy.resultAria}>
      <div className="grid shrink-0 gap-2 border-b px-3 pb-2 pt-3 sm:px-5 min-[600px]:grid-cols-[minmax(0,1fr)_auto] min-[600px]:items-center" style={{ borderColor: theme.panelBorder }}>
        <div className="lm-inline-scroll -mt-1 flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto pb-2 pt-1">
          <GlassChip theme={theme}>{getPlatformLabel(result.platform, copy)}</GlassChip>
          <a
            className="lm-themed-action inline-flex h-9 max-w-full shrink-0 cursor-pointer items-center rounded-full border px-3 text-[13px] font-semibold transition"
            href={result.canonical_url}
            rel="noreferrer"
            style={buildLinkChipStyle(theme)}
            target="_blank"
          >
            <span className="truncate">{copy.openProfile}</span>
          </a>
          <GlassChip theme={theme}>{copy.postsVisibleCount(result.posts.length, totalPosts)}</GlassChip>
          <GlassChip theme={theme}>{copy.selectedPostsCount(selectedPostIds.length)}</GlassChip>
        </div>

        {expiryText ? (
          <div className="justify-self-start min-[600px]:justify-self-end">
            <GlassChip alignRight theme={theme}>
              {copy.expiredAt} {expiryText}
            </GlassChip>
          </div>
        ) : null}
      </div>

      {searchLoginPlatforms.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 sm:px-5" style={{ borderColor: theme.panelBorder }}>
          <span className="text-xs font-semibold" style={{ color: theme.mutedText }}>{copy.searchLoginTitle}</span>
          {searchLoginPlatforms.map((platform) => (
            <button
              className={`${actionButtonBaseClass} h-9 px-3 text-[13px]`}
              key={platform}
              onClick={() => onLoginPlatform(platform)}
              style={buildPrimaryButtonStyle(theme, false)}
              type="button"
            >
              <span aria-hidden="true" className="mr-1.5 inline-block size-2 rounded-full" style={{ backgroundColor: keywordSearchPlatforms.find((item) => item.id === platform)?.color || theme.accent }} />
              {getPlatformLabel(platform, copy)} {platform === "xiaohongshu" && isXiaohongshuAuthenticated ? copy.searchRetryButton : copy.searchLoginButton}
            </button>
          ))}
        </div>
      ) : null}

      <div className="grid shrink-0 gap-2 border-b px-3 py-2 sm:px-5 min-[600px]:grid-cols-[minmax(0,1fr)_auto] min-[600px]:items-start" style={{ borderColor: theme.panelBorder }}>
        <div className="flex min-w-0 items-start gap-3 min-[600px]:items-center">
          {avatarUrl ? (
            <img
              alt={profile.full_name || profile.username || result.creator_handle}
              className="mt-0.5 size-14 shrink-0 rounded-2xl border object-cover shadow-[0_14px_28px_rgba(15,23,42,0.12)] min-[600px]:size-12"
              src={avatarUrl}
              style={{
                borderColor: theme.panelBorder,
                background: theme.previewGradient,
              }}
            />
          ) : null}

          <div className="grid min-w-0 gap-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2 min-[600px]:flex-nowrap">
              <span className="truncate text-base font-semibold sm:text-lg" style={{ color: theme.titleText }}>
                {profile.full_name || `@${profile.username || result.creator_handle}`}
              </span>
              <span className="truncate rounded-full border px-2 py-0.5 text-xs font-semibold" style={buildInfoBadgeStyle(theme)}>
                @{profile.username || result.creator_handle}
              </span>
              {profile.is_verified ? (
                <span className="rounded-full border px-2 py-0.5 text-xs font-semibold" style={buildInfoBadgeStyle(theme)}>
                  {copy.verified}
                </span>
              ) : null}
            </div>

            <div className="lm-inline-scroll flex min-w-0 flex-wrap items-center gap-2 overflow-visible min-[600px]:flex-nowrap min-[600px]:overflow-x-auto">
              {statItems.map((item) => (
                <StatPill key={item.key} label={item.label} language={language} theme={theme} value={item.value} />
              ))}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 min-[600px]:flex-nowrap min-[600px]:justify-end">
          <button className={`${actionButtonBaseClass} lm-cohere-contrast-hover h-9 px-3 text-[13px]`} onClick={onToggleAll} style={buildSecondaryButtonStyle(theme)} type="button">
            {allSelected ? copy.none : copy.all}
          </button>
          <button className={`${actionButtonBaseClass} lm-cohere-contrast-hover h-9 px-3 text-[13px]`} onClick={onInvertSelection} style={buildSecondaryButtonStyle(theme)} type="button">
            {copy.invert}
          </button>
          <button
            className={`${actionButtonBaseClass} h-9 px-4 text-[13px]`}
            disabled={!result.request_id || selectedPosts.length === 0 || isDownloading}
            onClick={onDownloadSelected}
            style={buildPrimaryButtonStyle(theme, !result.request_id || selectedPosts.length === 0 || isDownloading)}
            title={!result.request_id ? copy.searchDownloadUnavailable : undefined}
            type="button"
          >
            {isDownloading ? profileDownloadButtonLabel(copy, profileDownloadJob) : result.request_id ? copy.downloadSelectedPosts : copy.searchDownloadUnavailable}
          </button>
        </div>
      </div>

      <FloatingScrollArea onScroll={onPostsScroll} theme={theme}>
        <ProfilePostGrid
          copy={copy}
          hasMore={Boolean(page.has_more)}
          isLoadingMore={isLoadingMore}
          isPartialSnapshot={Boolean(page.is_partial_snapshot)}
          language={language}
          posts={result.posts}
          platform={result.platform}
          postDownloadStatuses={profileDownloadJob?.post_statuses}
          selectedPostIds={selectedPostIds}
          theme={theme}
          onTogglePost={onTogglePost}
          onOpenPostDetail={onOpenPostDetail}
        />
      </FloatingScrollArea>
    </section>
  );
}

function ProfilePostGrid({ copy, hasMore, isLoadingMore, isPartialSnapshot, language, onOpenPostDetail, onTogglePost, platform, postDownloadStatuses, posts, selectedPostIds, theme }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,11.5rem),1fr))] gap-2.5 pb-1 sm:grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] sm:gap-3 xl:grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))]">
      {posts.map((post) => {
        const isSelected = selectedPostIds.includes(post.id);
        const downloadStatus = postDownloadStatuses?.[post.id] ?? null;
        const normalizedDownloadStatus = normalizeProfileDownloadStatus(downloadStatus?.status);
        const excerpt = profilePostExcerpt(post);
        const dateText = formatProfilePostDate(post.taken_at, language);
        const postPlatform = post.platform || platform;
        const postTheme = getButtonTheme(postPlatform, theme.colorMode, theme.uiTheme === "cohere" ? "cohere" : "default");
        const previewUrl = profileImageUrl(post.preview_url, postPlatform, "image");

        return (
          <article
            aria-pressed={isSelected}
            className={`lm-profile-post-card group grid min-w-0 content-start gap-3 rounded-[1.2rem] border p-3 outline-none backdrop-blur-xl transition duration-300 focus:outline-none focus-visible:outline-none ${profilePostDownloadCardClass(normalizedDownloadStatus)}`}
            key={post.id}
            style={buildProfilePostCardStyle(theme, isSelected, normalizedDownloadStatus)}
          >
            <div className="relative aspect-square overflow-hidden rounded-[1rem] border" style={{ borderColor: theme.panelBorder, background: theme.previewGradient }}>
              <button
                aria-label={isSelected ? copy.unselectPost : copy.selectPost}
                aria-pressed={isSelected}
                className="absolute inset-0 z-10 cursor-pointer p-0 text-left"
                onClick={() => onTogglePost(post.id)}
                type="button"
              >
                <span className="sr-only">{isSelected ? copy.unselectPost : copy.selectPost}</span>
              </button>

              {downloadStatus ? (
                <ProfilePostDownloadBadge copy={copy} status={downloadStatus} theme={theme} />
              ) : null}

              {previewUrl ? (
                <img
                  alt={post.post_info?.title || post.shortcode}
                  className="h-full w-full object-cover"
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                    event.currentTarget.nextElementSibling?.removeAttribute("hidden");
                  }}
                  src={previewUrl}
                />
              ) : (
                <div className="grid h-full w-full place-items-center text-sm font-semibold" style={{ color: theme.mutedText }}>
                  {getPlatformLabel(postPlatform, copy)}
                </div>
              )}

              {previewUrl ? (
                <div hidden className="absolute inset-0 grid place-items-center text-sm font-semibold" style={{ color: theme.mutedText }}>
                  {getPlatformLabel(postPlatform, copy)}
                </div>
              ) : null}

              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-between gap-2 bg-[linear-gradient(180deg,rgba(10,18,30,0)_0%,rgba(10,18,30,0.72)_100%)] px-3 pb-3 pt-8 text-white">
                <span
                  className="inline-flex max-w-[calc(100%-2rem)] items-center rounded-full border px-2.5 py-1 text-[11px] font-bold shadow-[0_8px_18px_rgba(15,23,42,0.16)] backdrop-blur-md"
                  style={{
                    color: postTheme.accentText,
                    backgroundColor: hexToRgba(postTheme.accent, theme.colorMode === "dark" ? 0.24 : 0.12),
                    borderColor: hexToRgba(postTheme.accent, theme.colorMode === "dark" ? 0.62 : 0.34),
                  }}
                >
                  <span aria-hidden="true" className="mr-1.5 size-1.5 rounded-full" style={{ backgroundColor: postTheme.accent }} />
                  {getPlatformLabel(postPlatform, copy)}
                </span>
              </div>

              <button
                aria-label={isSelected ? copy.unselectPost : copy.selectPost}
                aria-pressed={isSelected}
                className="absolute bottom-3 right-3 z-30 grid size-6 shrink-0 cursor-pointer place-items-center rounded-full border transition hover:scale-110"
                onClick={() => onTogglePost(post.id)}
                style={buildProfilePostSelectionStyle(theme, isSelected)}
                type="button"
              >
                {isSelected ? <SelectionCheckIcon /> : null}
              </button>
            </div>

            <div className="grid min-w-0 gap-2">
              <button
                aria-pressed={isSelected}
                className="grid cursor-pointer gap-1 text-left"
                onClick={() => onTogglePost(post.id)}
                style={{ color: theme.bodyText }}
                type="button"
              >
                <span className="truncate text-sm font-semibold" style={{ color: theme.bodyText }} title={post.post_info?.title || post.shortcode}>
                  {post.post_info?.title || `@${post.post_info?.author_handle || ""}`}
                </span>
                {excerpt ? (
                  <span className="line-clamp-3 text-xs leading-5 sm:text-[13px]" style={{ color: theme.mutedText }}>
                    {excerpt}
                  </span>
                ) : null}
              </button>

              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                {Number.isFinite(post.metrics?.like_count) ? <MiniMetric theme={theme} label={copy.likes} value={post.metrics.like_count} /> : null}
                {Number.isFinite(post.metrics?.comment_count) ? <MiniMetric theme={theme} label={copy.comments} value={post.metrics.comment_count} /> : null}
                {Number.isFinite(post.metrics?.view_count) ? <MiniMetric theme={theme} label={copy.views} value={post.metrics.view_count} /> : null}
                {dateText ? <MiniMetric theme={theme} label={dateText} value={null} /> : null}
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="truncate text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: theme.subtleText }}>
                  {post.media_type}
                </span>
                <button
                  className="lm-themed-action inline-flex h-8 shrink-0 items-center rounded-full border px-3 text-[12px] font-semibold transition"
                  onClick={() => onOpenPostDetail(post)}
                  style={buildLinkChipStyle(theme)}
                  type="button"
                >
                  {copy.openPost}
                </button>
              </div>
            </div>
          </article>
        );
      })}
      <div className="col-span-full grid min-h-12 place-items-center px-3 py-2 text-center text-sm font-semibold" style={{ color: theme.mutedText }}>
        {isLoadingMore ? copy.loadingMorePosts : hasMore ? copy.loadMorePosts : isPartialSnapshot ? copy.postsPartial : copy.postsEnd}
      </div>
    </div>
  );
}

function MiniMetric({ label, theme, value }) {
  return (
    <span
      className="inline-flex max-w-full items-center rounded-full border px-2 py-1 text-[11px] font-medium"
      style={{
        color: theme.subtleText,
        borderColor: theme.chipBorder,
        background: theme.selectionBackground,
      }}
      title={label}
    >
      <span className="truncate">
        {value == null ? label : `${label} ${formatCompactNumber(value)}`}
      </span>
    </span>
  );
}

function ProfilePostDownloadBadge({ copy, status, theme }) {
  const normalizedStatus = normalizeProfileDownloadStatus(status?.status);
  const label = profilePostDownloadStatusLabel(copy, normalizedStatus);

  return (
    <div
      className="pointer-events-none absolute right-2 top-2 z-30 inline-flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold shadow-[0_12px_28px_rgba(15,23,42,0.18)] backdrop-blur-xl"
      style={buildProfilePostDownloadBadgeStyle(theme, normalizedStatus)}
      title={status?.message || label}
    >
      {normalizedStatus === "downloading" ? (
        <span className="block size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : null}
      <span className="truncate">{label}</span>
    </div>
  );
}

function createProfileMetricItems(profile, copy) {
  return [
    { key: "posts", label: copy.posts, value: profile?.post_count },
    { key: "followers", label: copy.followers, value: profile?.follower_count },
    { key: "following", label: copy.following, value: profile?.following_count },
  ].filter((item) => Number.isFinite(item.value));
}

function profilePostExcerpt(post) {
  return post?.post_info?.body || post?.post_info?.title || "";
}

function formatProfilePostDate(value, language = "zh") {
  const timestamp = Date.parse(value || "");

  if (!Number.isFinite(timestamp)) {
    return "";
  }

  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function instagramAvatarProxyUrl(sourceUrl) {
  if (!sourceUrl) {
    return "";
  }

  return apiUrl(`/api/v1/instagram/avatar?url=${encodeURIComponent(sourceUrl)}`);
}

function instagramImageProxyUrl(sourceUrl) {
  if (!sourceUrl) {
    return "";
  }

  return apiUrl(`/api/v1/instagram/image?url=${encodeURIComponent(sourceUrl)}`);
}

function xiaohongshuImageProxyUrl(sourceUrl) {
  if (!sourceUrl) {
    return "";
  }

  return apiUrl(`/api/v1/xiaohongshu/image?url=${encodeURIComponent(sourceUrl)}`);
}

function profileImageUrl(sourceUrl, platform, kind) {
  if (!sourceUrl) {
    return "";
  }

  if (platform === "instagram") {
    return kind === "avatar" ? instagramAvatarProxyUrl(sourceUrl) : instagramImageProxyUrl(sourceUrl);
  }

  if (platform === "xiaohongshu") {
    return xiaohongshuImageProxyUrl(sourceUrl);
  }

  return sourceUrl;
}

function PreferenceControls({
  colorMode,
  copy,
  isCohereTheme = false,
  language,
  onColorModeChange,
  onLanguageChange,
  theme,
}) {
  return (
    <div
      aria-label={copy.preferences}
      className={isCohereTheme
        ? "relative z-30 flex w-full shrink-0 justify-end pb-1 pt-3 lg:absolute lg:inset-x-0 lg:top-3 lg:pr-12 lg:pt-0"
        : "absolute inset-x-3 top-3 z-30 sm:inset-x-7 sm:top-5 lg:inset-x-10"}
    >
      <div className={isCohereTheme ? "flex w-full flex-wrap justify-end gap-2" : "mx-auto flex w-full max-w-6xl flex-wrap justify-end gap-2"}>
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

function CohereEmptyState({ copy, theme }) {
  const isEnglish = copy.search === "Search";

  return (
    <section
      aria-label={copy.resultAria}
      className="flex min-h-0 w-full flex-1 flex-col justify-start overflow-hidden rounded-[1.75rem] border p-6 sm:p-8 lg:p-10"
      style={buildResultShellStyle(theme)}
    >
      <div className="flex items-start justify-between gap-4">
        <span className="font-mono text-xs uppercase tracking-[0.14em]" style={{ color: theme.accentStrong }}>
          Workspace / Ready
        </span>
        <span className="size-2.5 rounded-full" style={{ backgroundColor: theme.accent }} />
      </div>

      <div className="mt-[clamp(4rem,8vh,5.5rem)] max-w-2xl">
        <h2 className="max-w-xl text-[2.15rem] leading-[1.02] tracking-[-0.05em] sm:text-[3.5rem]" style={{ color: theme.titleText }}>
          {isEnglish ? "Your next signal starts here." : "从这里开始，捕捉下一条灵感。"}
        </h2>
        <p className="mt-5 max-w-lg text-base leading-7" style={{ color: theme.mutedText }}>
          {isEnglish
            ? "Paste a public social link or search a keyword. Results, media, and post details will gather in this workspace."
            : "粘贴公开社媒链接，或输入关键词开始搜索。搜索结果、媒体资源和帖子信息会集中显示在这里。"}
        </p>
      </div>

    </section>
  );
}

function FloatingScrollArea({ children, className = "", contentClassName = "px-3 py-3 sm:px-5", onScroll, theme }) {
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

  const handleScroll = useCallback((event) => {
    updateScrollbar();
    onScroll?.(event);
  }, [onScroll, updateScrollbar]);

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
    <div className={`group relative min-h-0 flex-1 ${className}`}>
      <div
        className={`lm-floating-scroll h-full min-h-0 overflow-y-auto ${contentClassName}`}
        onScroll={handleScroll}
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
      className={`${glassPanelClass} ${theme.panelClass} grid min-h-0 w-full flex-1 grid-rows-[auto_auto_minmax(0,1fr)] gap-5 overflow-hidden rounded-[2rem] p-5 sm:p-6`}
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

      <FloatingScrollArea className="h-full min-h-0" contentClassName="pr-1 pb-1" theme={theme}>
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
      </FloatingScrollArea>
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

function SelectionCheckIcon() {
  return (
    <svg aria-hidden="true" className="size-3.5" fill="none" viewBox="0 0 16 16">
      <path d="m3.25 8.25 3 3 6.5-7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg aria-hidden="true" className="size-3.5" fill="none" viewBox="0 0 24 24">
      <path d="M12 11v6" stroke="currentColor" strokeLinecap="round" strokeWidth="2.4" />
      <path d="M12 7.4h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="3.2" />
      <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24">
      <path d="m15 6-6 6 6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg aria-hidden="true" className="size-5" fill="none" viewBox="0 0 24 24">
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" />
    </svg>
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
      <path d="M7 16l3.2-3.2a1.2 1.2 0 0 1 1.7 0L15 16l1.2-1.2a1.2 1.2 0 0 1 1.7 0L21 18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
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

function DownloadContentsModal({ copy, onClose, onDownload, result, theme }) {
  const chrome = getPostChrome(result.platform, theme);
  const [includeMedia, setIncludeMedia] = useState(true);
  const [includePostText, setIncludePostText] = useState(false);
  const [includeComments, setIncludeComments] = useState(false);
  const [commentLimit, setCommentLimit] = useState(20);
  const canDownload = includeMedia || includePostText || includeComments;

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    }

    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  function submit(event) {
    event.preventDefault();
    if (!canDownload) return;

    onDownload({
      includeMedia,
      includePostText,
      includeComments,
      commentLimit: Math.min(100, Math.max(1, Number.parseInt(commentLimit, 10) || 20)),
    });
  }

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center px-5 py-6 backdrop-blur-[14px]" onMouseDown={onClose} role="presentation" style={buildPostModalBackdropStyle(theme)}>
      <form
        aria-label={copy.downloadContents}
        aria-modal="true"
        className="w-full max-w-[30rem] rounded-[1.25rem] border p-5 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
        role="dialog"
        style={{ background: chrome.contentBackground, borderColor: chrome.divider, color: chrome.text, boxShadow: chrome.shellShadow }}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-black" style={{ color: chrome.text }}>{copy.downloadContents}</h2>
            <p className="mt-1 text-xs font-medium" style={{ color: chrome.muted }}>{result.shortcode}</p>
          </div>
          <button aria-label={copy.closeDetails} className="grid size-9 cursor-pointer place-items-center rounded-full border" onClick={onClose} style={buildPostCloseButtonStyle(chrome)} type="button">
            <ClearIcon />
          </button>
        </div>

        <div className="grid gap-3">
          <DownloadOptionRow checked={includeMedia} chrome={chrome} label={copy.downloadMedia} onChange={setIncludeMedia} />
          <DownloadOptionRow checked={includePostText} chrome={chrome} label={copy.downloadPostText} onChange={setIncludePostText} />
          <DownloadOptionRow checked={includeComments} chrome={chrome} label={copy.downloadComments} onChange={setIncludeComments} />
        </div>

        {includeComments ? (
          <label className="mt-4 grid gap-2 text-sm font-bold" style={{ color: chrome.text }}>
            <span>{copy.commentCount}</span>
            <input
              className="h-10 rounded-xl border px-3 text-sm font-semibold outline-none"
              max="100"
              min="1"
              onChange={(event) => setCommentLimit(event.target.value)}
              style={{ background: chrome.metricBackground, borderColor: chrome.divider, color: chrome.text }}
              type="number"
              value={commentLimit}
            />
            <span className="text-xs font-medium" style={{ color: chrome.muted }}>{copy.commentCountHint}</span>
          </label>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <button className={`${actionButtonBaseClass} lm-download-cancel h-10 px-4 text-sm`} onClick={onClose} style={buildSecondaryButtonStyle(theme)} type="button">{copy.cancel}</button>
          <button className={`${actionButtonBaseClass} h-10 px-4 text-sm`} disabled={!canDownload} style={buildPrimaryButtonStyle(theme, !canDownload)} type="submit">{copy.startDownload}</button>
        </div>
      </form>
    </div>
  );
}

function DownloadOptionRow({ checked, chrome, label, onChange }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 text-sm font-bold" style={{ background: checked ? chrome.pillBackground : chrome.metricBackground, borderColor: checked ? chrome.accent : chrome.divider, color: chrome.text }}>
      <input checked={checked} onChange={(event) => onChange(event.target.checked)} style={{ accentColor: chrome.accent }} type="checkbox" />
      <span>{label}</span>
    </label>
  );
}

function PostInfoModal({
  copy,
  initialAssetIndex = 0,
  language,
  onClose,
  onDownloadAll,
  onDownloadAsset,
  result,
  theme,
}) {
  const info = result.post_info ?? {};
  const metrics = info.metrics ?? result.metrics;
  const title = displayTitle(info);
  const author = displayAuthorName(info, result);
  const handle = displayAuthorHandle(info, result);
  const body = info.body || "";
  const tags = Array.isArray(info.tags) ? info.tags : [];
  const metricItems = createMetricItems(metrics, copy);
  const postChrome = getPostChrome(result.platform, theme);
  const assets = Array.isArray(result.assets) ? result.assets : [];
  const [assetIndex, setAssetIndex] = useState(() => clampAssetIndex(initialAssetIndex, assets.length));
  const [isAssetPreviewOpen, setIsAssetPreviewOpen] = useState(false);
  const [isCommentsOpen, setIsCommentsOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [toastId, setToastId] = useState(0);
  const previewAsset = assets[assetIndex] ?? assets[0] ?? null;
  const hasMultipleAssets = assets.length > 1;
  const canOpenComments = canOpenPostComments(result);

  const openAssetPreview = useCallback((nextIndex) => {
    const clampedIndex = clampAssetIndex(nextIndex, assets.length);
    const asset = assets[clampedIndex];

    if (!asset) {
      return;
    }

    setAssetIndex(clampedIndex);
    setIsAssetPreviewOpen(true);
    logClientAction("post_modal_asset_preview_clicked", {
      asset_id: asset.id,
      filename: asset.filename,
      media_type: asset.media_type,
      preview_url: asset.preview_url,
    });
  }, [assets]);

  const showPreviousAsset = useCallback(() => {
    setAssetIndex((current) => (assets.length ? (current - 1 + assets.length) % assets.length : 0));
  }, [assets.length]);

  const showNextAsset = useCallback(() => {
    setAssetIndex((current) => (assets.length ? (current + 1) % assets.length : 0));
  }, [assets.length]);

  const downloadCurrentAsset = useCallback(() => {
    if (!previewAsset) {
      return;
    }

    onDownloadAsset?.(previewAsset);
  }, [onDownloadAsset, previewAsset]);

  const downloadAllAssets = useCallback(() => {
    if (!assets.length) {
      return;
    }

    onDownloadAll?.();
  }, [assets.length, onDownloadAll]);

  const copyText = useCallback(async (text, successMessage, event) => {
    const value = String(text || "").trim();

    if (!value) {
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setToast({ message: successMessage });
      setToastId((current) => current + 1);
    } catch {
      setToast({ message: copy.copyFailed });
      setToastId((current) => current + 1);
    }
  }, [copy.copyFailed]);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape") {
        if (isAssetPreviewOpen) {
          setIsAssetPreviewOpen(false);
          return;
        }

        if (isCommentsOpen) {
          setIsCommentsOpen(false);
          return;
        }

        onClose();
      }

      if (hasMultipleAssets && event.key === "ArrowLeft") {
        event.preventDefault();
        showPreviousAsset();
      }

      if (hasMultipleAssets && event.key === "ArrowRight") {
        event.preventDefault();
        showNextAsset();
      }
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [hasMultipleAssets, isAssetPreviewOpen, isCommentsOpen, onClose, showNextAsset, showPreviousAsset]);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setToast(null);
    }, 1600);

    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    setAssetIndex(clampAssetIndex(initialAssetIndex, assets.length));
    setIsAssetPreviewOpen(false);
    setIsCommentsOpen(false);
  }, [assets.length, initialAssetIndex, result.request_id]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center px-8 py-7 backdrop-blur-[18px]"
      onMouseDown={onClose}
      role="presentation"
      style={buildPostModalBackdropStyle(theme)}
    >
      <section
        aria-label={copy.postDetails}
        aria-modal="true"
        className="relative grid h-[min(84vh,45rem)] w-[min(92vw,70rem)] grid-cols-[minmax(0,1.08fr)_minmax(23rem,0.92fr)] overflow-hidden rounded-[1.4rem] border shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        style={buildPlatformPostShellStyle(postChrome)}
      >
        <SocialPostMediaPane
          assetIndex={assetIndex}
          asset={previewAsset}
          assetCount={assets.length}
          chrome={postChrome}
          copy={copy}
          hasMultipleAssets={hasMultipleAssets}
          onNext={showNextAsset}
          onOpenAsset={openAssetPreview}
          onPrevious={showPreviousAsset}
          platform={result.platform}
          title={title || body || result.shortcode}
        />

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]" style={{ background: postChrome.contentBackground }}>
          <div className="flex min-w-0 items-center justify-between gap-3 border-b px-5 py-4" style={{ borderColor: postChrome.divider }}>
            <div className="flex min-w-0 items-center gap-3">
              <PlatformAvatar chrome={postChrome} handle={handle || author || result.platform} />
              <div className="min-w-0">
                <div className="truncate text-[15px] font-bold" style={{ color: postChrome.text }}>
                  {author || handle || getPlatformLabel(result.platform, copy)}
                </div>
                <div className="truncate text-xs font-semibold" style={{ color: postChrome.muted }}>
                  {handle ? `@${handle.replace(/^@+/, "")}` : getPlatformLabel(result.platform, copy)}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <PostDownloadButton
                chrome={postChrome}
                copy={copy}
                disabled={!previewAsset}
                onDownload={result.platform === "xiaohongshu" ? downloadAllAssets : downloadCurrentAsset}
              />
              <button
                aria-label={copy.closeDetails}
                className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border transition hover:scale-[1.03]"
                onClick={onClose}
                style={buildPostCloseButtonStyle(postChrome)}
                type="button"
              >
                <ClearIcon />
              </button>
            </div>
          </div>

          <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4 px-5 py-5">
            <div className="grid shrink-0 gap-4">
              <div className="flex items-center justify-between gap-3">
                <span className="rounded-full px-3 py-1.5 text-xs font-bold" style={buildPostPlatformPillStyle(postChrome)}>
                  {getPlatformLabel(result.platform, copy)}
                </span>
                <span className="text-xs font-semibold" style={{ color: postChrome.muted }}>
                  {postChrome.surfaceLabel}
                </span>
              </div>

              {title ? (
                <h2
                  className="cursor-pointer break-words text-[1.55rem] font-black leading-tight transition hover:opacity-75"
                  onClick={(event) => copyText(title, copy.copiedTitle, event)}
                  role="button"
                  style={{ color: postChrome.text }}
                  tabIndex={0}
                  title={copy.copyTitle}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      copyText(title, copy.copiedTitle, event);
                    }
                  }}
                >
                  {title}
                </h2>
              ) : null}
            </div>

            <FloatingScrollArea className="min-h-0" contentClassName="pr-5" theme={{ ...theme, accent: postChrome.accent }}>
              <div className="grid gap-5 pb-1">
                <div
                  className={`break-words whitespace-pre-wrap text-[15px] font-medium leading-7 ${body ? "cursor-pointer transition hover:opacity-75" : ""}`}
                  onClick={(event) => body && copyText(body, copy.copiedBody, event)}
                  onKeyDown={(event) => {
                    if (body && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      copyText(body, copy.copiedBody, event);
                    }
                  }}
                  role={body ? "button" : undefined}
                  style={{ color: postChrome.text }}
                  tabIndex={body ? 0 : undefined}
                  title={body ? copy.copyBody : undefined}
                >
                  {body || copy.noContent}
                </div>

                {tags.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {tags.map((tag) => (
                      <span className="max-w-full break-all rounded-full px-3 py-1.5 text-xs font-bold" key={tag} style={buildPostTagStyle(postChrome)}>
                        #{tag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </FloatingScrollArea>
          </div>

          <div className="border-t px-5 py-4" style={{ borderColor: postChrome.divider }}>
            <PostMetricBar
              chrome={postChrome}
              copy={copy}
              items={metricItems}
              language={language}
              onCommentsClick={canOpenComments ? () => setIsCommentsOpen(true) : null}
            />
          </div>
        </div>

        {isCommentsOpen ? (
          <PostCommentsModal
            chrome={postChrome}
            copy={copy}
            language={language}
            onClose={() => setIsCommentsOpen(false)}
            onCopyComment={copyText}
            result={result}
          />
        ) : null}

        {isAssetPreviewOpen && previewAsset ? (
          <ResourcePreviewModal
            asset={previewAsset}
            chrome={postChrome}
            copy={copy}
            hasMultipleAssets={hasMultipleAssets}
            onClose={() => setIsAssetPreviewOpen(false)}
            onDownloadAsset={downloadCurrentAsset}
            onNext={showNextAsset}
            onPrevious={showPreviousAsset}
            title={title || body || result.shortcode}
          />
        ) : null}

        {toast ? (
          <div
            key={toastId}
            className="lm-copy-toast pointer-events-none absolute left-1/2 top-4 z-50 rounded-full border px-4 py-2 text-sm font-bold shadow-[0_18px_42px_rgba(15,23,42,0.16)]"
            style={buildPostToastStyle(postChrome)}
          >
            {toast.message}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function PostDownloadButton({ chrome, copy, disabled, onDownload }) {
  return (
    <button
      className="inline-flex h-10 shrink-0 cursor-pointer items-center justify-center rounded-full border px-5 text-sm font-black transition hover:scale-[1.02] disabled:cursor-not-allowed disabled:hover:scale-100"
      disabled={disabled}
      onClick={onDownload}
      style={buildPostDownloadButtonStyle(chrome, disabled)}
      type="button"
    >
      {copy.download}
    </button>
  );
}

function SocialPostMediaPane({
  asset,
  assetCount,
  assetIndex,
  chrome,
  copy,
  hasMultipleAssets,
  onNext,
  onOpenAsset,
  onPrevious,
  platform,
  title,
}) {
  function openCurrentAsset() {
    onOpenAsset?.(assetIndex);
  }

  function onPreviewKeyDown(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openCurrentAsset();
    }
  }

  return (
    <div className="relative min-h-0 overflow-hidden" style={{ background: chrome.mediaBackground }}>
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-5 py-4">
        <span className="text-xs font-black uppercase tracking-[0.18em]" style={{ color: chrome.mediaText }}>
          {chrome.mediaLabel}
        </span>
        <span className="rounded-full px-3 py-1 text-xs font-bold" style={buildPostMediaBadgeStyle(chrome)}>
          {platformMediaLabel(platform, copy)}
        </span>
      </div>

      <div className="grid h-full place-items-center px-8 py-14">
        <div
          aria-label={asset?.filename || title}
          className={`relative flex aspect-[4/5] max-h-full w-full max-w-[29rem] items-center justify-center overflow-hidden rounded-[1.15rem] border outline-none transition hover:scale-[1.01] focus:outline-none focus-visible:outline-none ${
            asset ? "cursor-zoom-in" : ""
          }`}
          onClick={asset ? openCurrentAsset : undefined}
          onKeyDown={asset ? onPreviewKeyDown : undefined}
          onMouseDown={asset ? (event) => event.preventDefault() : undefined}
          role={asset ? "button" : undefined}
          style={buildPostMediaFrameStyle(chrome)}
          tabIndex={asset ? 0 : undefined}
          title={asset?.filename || title}
        >
          <PostAssetPreview asset={asset} chrome={chrome} title={title} />
        </div>
      </div>

      {hasMultipleAssets ? (
        <>
          <button
            aria-label={copy.previous}
            className="absolute left-4 top-1/2 z-20 grid size-11 -translate-y-1/2 cursor-pointer place-items-center rounded-full border text-sm font-black shadow-[0_14px_34px_rgba(4,15,32,0.22)] backdrop-blur-xl transition hover:scale-[1.04]"
            onClick={onPrevious}
            style={buildPostMediaNavStyle(chrome)}
            type="button"
          >
            <ChevronLeftIcon />
          </button>
          <button
            aria-label={copy.next}
            className="absolute right-4 top-1/2 z-20 grid size-11 -translate-y-1/2 cursor-pointer place-items-center rounded-full border text-sm font-black shadow-[0_14px_34px_rgba(4,15,32,0.22)] backdrop-blur-xl transition hover:scale-[1.04]"
            onClick={onNext}
            style={buildPostMediaNavStyle(chrome)}
            type="button"
          >
            <ChevronRightIcon />
          </button>
          <div className="absolute bottom-5 left-1/2 z-20 -translate-x-1/2 rounded-full border px-3 py-1 text-xs font-bold backdrop-blur-xl" style={buildPostMediaCounterStyle(chrome)}>
            {assetIndex + 1} / {assetCount}
          </div>
        </>
      ) : null}
    </div>
  );
}

function PostAssetPreview({ asset, chrome, title }) {
  if (!asset) {
    return (
      <div className="grid h-full w-full place-items-center px-8 text-center" style={{ color: chrome.mediaText }}>
        <span className="text-lg font-bold">{title}</span>
      </div>
    );
  }

  const previewUrl = apiUrl(asset.preview_url);

  if (asset.media_type === "video") {
    return (
      <video
        className="h-full w-full object-cover"
        controls
        muted
        onClick={(event) => event.stopPropagation()}
        playsInline
        preload="metadata"
        src={previewUrl}
      />
    );
  }

  if (asset.media_type === "audio") {
    const label = title || asset.filename || "Audio";

    return (
      <div className="grid h-full w-full grid-rows-[minmax(0,1fr)_auto] gap-6 p-6 sm:p-7" style={{ background: chrome.audioBackground }}>
        <div className="flex min-h-0 flex-col items-center justify-center gap-4 text-center">
          <div className="grid size-28 shrink-0 place-items-center rounded-full border text-5xl font-black" style={buildPostAudioIconStyle(chrome)}>
            ♪
          </div>
          <div className="grid max-w-full gap-2">
            <div className="max-h-32 overflow-hidden break-words text-xl font-black leading-snug" style={{ color: chrome.mediaText }} title={label}>
              {label}
            </div>
            <div className="truncate text-xs font-semibold" style={{ color: chrome.muted }} title={asset.filename}>
              {asset.filename}
            </div>
          </div>
        </div>
        <audio aria-label={label} className="w-full" controls onClick={(event) => event.stopPropagation()} preload="metadata" src={previewUrl} />
      </div>
    );
  }

  if (asset.media_type === "text") {
    return (
      <iframe
        className="h-full w-full border-0 bg-white"
        src={previewUrl}
        title={asset.filename || title || "Text"}
      />
    );
  }

  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      alt={title}
      className="h-full w-full object-contain"
      draggable={false}
      src={previewUrl}
    />
  );
}

function ResourcePreviewModal({ asset, chrome, copy, hasMultipleAssets, onClose, onDownloadAsset, onNext, onPrevious, title }) {
  const previewUrl = apiUrl(asset.preview_url);

  return (
    <div
      aria-label={asset.filename}
      aria-modal="true"
      className="fixed inset-0 z-[80] grid place-items-center overflow-hidden p-3 sm:p-5"
      onMouseDown={(event) => {
        event.stopPropagation();
        onClose();
      }}
      role="dialog"
    >
      <ResourcePreviewBackdrop asset={asset} chrome={chrome} previewUrl={previewUrl} />

      <div
        className="relative z-10 flex h-[calc(100svh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-7xl flex-col overflow-hidden rounded-[1.45rem] border shadow-[0_34px_90px_rgba(4,15,32,0.34)] backdrop-blur-[34px] sm:h-[calc(100svh-2.5rem)] sm:w-[calc(100vw-2.5rem)]"
        onMouseDown={(event) => event.stopPropagation()}
        style={buildResourcePreviewShellStyle(chrome)}
      >
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-3 backdrop-blur-[26px] sm:px-4" style={buildResourcePreviewHeaderStyle(chrome)}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="grid size-9 shrink-0 place-items-center rounded-full border" style={buildPostResourceIconStyle(chrome, true)}>
              <MediaTypeIcon type={asset.media_type} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-black" style={{ color: chrome.mediaText }} title={asset.filename}>
                {asset.filename}
              </p>
              <p className="truncate text-xs font-semibold" style={{ color: chrome.muted }}>
                {assetMediaLabel(asset, copy)} · {formatBytes(asset.size_bytes)}
              </p>
            </div>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              className="inline-flex h-10 cursor-pointer items-center justify-center rounded-full border px-4 text-sm font-semibold shadow-[0_12px_28px_rgba(4,15,32,0.18)] backdrop-blur-xl transition"
              onClick={onDownloadAsset}
              style={buildResourcePreviewButtonStyle(chrome)}
              type="button"
            >
              {copy.download}
            </button>
            <button
              aria-label={copy.closePreview}
              className="grid size-10 cursor-pointer place-items-center rounded-full border text-xl leading-none shadow-[0_12px_28px_rgba(4,15,32,0.18)] backdrop-blur-xl transition"
              onClick={onClose}
              style={buildResourcePreviewButtonStyle(chrome)}
              type="button"
            >
              <ClearIcon />
            </button>
          </div>
        </div>

        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {hasMultipleAssets ? (
            <>
              <button
                aria-label={copy.previous}
                className="absolute left-3 top-1/2 z-20 hidden h-12 -translate-y-1/2 cursor-pointer items-center rounded-full border px-4 text-sm font-semibold shadow-[0_14px_34px_rgba(4,15,32,0.2)] backdrop-blur-xl transition sm:inline-flex"
                onClick={onPrevious}
                style={buildResourcePreviewButtonStyle(chrome)}
                type="button"
              >
                {copy.previous}
              </button>
              <button
                aria-label={copy.next}
                className="absolute right-3 top-1/2 z-20 hidden h-12 -translate-y-1/2 cursor-pointer items-center rounded-full border px-4 text-sm font-semibold shadow-[0_14px_34px_rgba(4,15,32,0.2)] backdrop-blur-xl transition sm:inline-flex"
                onClick={onNext}
                style={buildResourcePreviewButtonStyle(chrome)}
                type="button"
              >
                {copy.next}
              </button>
              <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 gap-2 sm:hidden">
                <button className="h-10 cursor-pointer rounded-full border px-4 text-sm font-semibold backdrop-blur-xl" onClick={onPrevious} style={buildResourcePreviewButtonStyle(chrome)} type="button">
                  {copy.previous}
                </button>
                <button className="h-10 cursor-pointer rounded-full border px-4 text-sm font-semibold backdrop-blur-xl" onClick={onNext} style={buildResourcePreviewButtonStyle(chrome)} type="button">
                  {copy.next}
                </button>
              </div>
            </>
          ) : null}

          <div className="absolute inset-3 grid min-h-0 min-w-0 place-items-center sm:inset-5">
            {asset.media_type === "video" ? (
              <video
                className="block h-auto max-h-full w-auto max-w-full rounded-[1.1rem] object-contain shadow-[0_24px_70px_rgba(4,15,32,0.28)]"
                controls
                playsInline
                preload="metadata"
                src={previewUrl}
                style={{ height: "auto", maxHeight: "calc(100svh - 9rem)", maxWidth: "100%", objectFit: "contain", width: "auto" }}
              />
            ) : asset.media_type === "audio" ? (
              <div className="grid w-full max-w-xl gap-5 rounded-[1.2rem] border p-6 text-center backdrop-blur-2xl" style={buildResourceAudioStyle(chrome)}>
                <span className="mx-auto grid size-20 place-items-center rounded-[1.2rem] border text-4xl" style={buildPostAudioIconStyle(chrome)}>
                  ♪
                </span>
                <div className="break-words text-lg font-black" style={{ color: chrome.text }}>
                  {title || asset.filename}
                </div>
                <audio className="w-full" controls preload="metadata" src={previewUrl} />
              </div>
            ) : asset.media_type === "text" ? (
              <iframe
                className="block h-full w-full rounded-[1.1rem] border bg-white shadow-[0_24px_70px_rgba(4,15,32,0.28)]"
                src={previewUrl}
                style={{ borderColor: chrome.mediaBorder }}
                title={asset.filename}
              />
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                alt={asset.filename}
                className="block h-auto max-h-full w-auto max-w-full rounded-[1.1rem] object-contain shadow-[0_24px_70px_rgba(4,15,32,0.28)]"
                draggable={false}
                src={previewUrl}
                style={{ height: "auto", maxHeight: "calc(100svh - 9rem)", maxWidth: "100%", objectFit: "contain", objectPosition: "center", width: "auto" }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ResourcePreviewBackdrop({ asset, chrome, previewUrl }) {
  return (
    <div className="absolute inset-0 overflow-hidden">
      {asset.media_type === "video" ? (
        <video className="absolute inset-0 h-full w-full scale-110 object-cover opacity-55 blur-[46px]" autoPlay loop muted playsInline src={previewUrl} />
      ) : asset.media_type === "image" ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-62 blur-[48px]" src={previewUrl} />
      ) : (
        <div className="absolute inset-0" style={{ background: chrome.audioBackground }} />
      )}
      <div className="absolute inset-0 backdrop-blur-[18px]" style={{ background: chrome.previewBackdropOverlay ?? "radial-gradient(circle at center, rgba(255,255,255,0.16), rgba(4,10,20,0.68) 74%)" }} />
      <div className="absolute inset-0" style={{ background: chrome.previewBackdropVeil ?? `linear-gradient(135deg, ${hexToRgba(chrome.accent, 0.22)} 0%, transparent 36%, rgba(4,10,20,0.46) 100%)` }} />
    </div>
  );
}

function PlatformAvatar({ chrome, handle }) {
  const initial = String(handle || "?").replace(/^@+/, "").trim()[0]?.toUpperCase() || "?";

  return (
    <div className="grid size-12 shrink-0 place-items-center rounded-full p-[2px]" style={{ background: chrome.avatarRing }}>
      <div className="grid size-full place-items-center rounded-full text-sm font-black" style={{ background: chrome.avatarFill, color: chrome.avatarText }}>
        {initial}
      </div>
    </div>
  );
}

function PostMetricBar({ chrome, copy, items, language, onCommentsClick }) {
  return (
    <div className="grid grid-cols-5 gap-2">
      {items.map((item) => {
        const isComments = item.key === "comments";
        const isInteractive = isComments && typeof onCommentsClick === "function";
        const content = (
          <>
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="grid size-7 shrink-0 place-items-center rounded-full" style={buildPostMetricIconStyle(chrome)}>
                <MetricIcon label={item.label} copy={copy} />
              </span>
              <div className="truncate text-[11px] font-bold" style={{ color: chrome.muted }}>{item.label}</div>
            </div>
            <div className="min-w-0 overflow-hidden">
              <MetricValue chrome={chrome} language={language} value={item.value} />
            </div>
          </>
        );

        if (isInteractive) {
          return (
            <button
              aria-label={copy.openComments}
              className="grid min-w-0 cursor-pointer gap-2 rounded-[0.85rem] px-2.5 py-2 text-left transition hover:-translate-y-0.5 hover:shadow-[0_14px_28px_rgba(15,23,42,0.12)]"
              key={item.key}
              onClick={onCommentsClick}
              style={buildPostMetricButtonStyle(chrome)}
              type="button"
            >
              {content}
            </button>
          );
        }

        return (
          <div className="grid min-w-0 gap-2 rounded-[0.85rem] px-2.5 py-2" key={item.key} style={buildPostMetricStyle(chrome)}>
            {content}
          </div>
        );
      })}
    </div>
  );
}

function PostCommentsModal({ chrome, copy, language, onClose, onCopyComment, result }) {
  const knownCommentCount = numberOrNull(result.metrics?.comment_count);
  const [comments, setComments] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [totalCount, setTotalCount] = useState(null);
  const [publicCount, setPublicCount] = useState(null);

  const fetchComments = useCallback(async (cursorValue) => {
    const response = await fetch("/api/v1/instagram/comments", {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: result.canonical_url,
        cursor: cursorValue,
        limit: 12,
      }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw payload;
    }

    return payload;
  }, [result.canonical_url]);

  useEffect(() => {
    let isActive = true;

    setComments([]);
    setCursor(null);
    setHasMore(false);
    setIsLoading(true);
    setIsLoadingMore(false);
    setError(null);
    setTotalCount(knownCommentCount);
    setPublicCount(null);

    fetchComments(null)
      .then((payload) => {
        if (!isActive) {
          return;
        }

        setComments(normalizeCommentList(payload.comments));
        setCursor(payload.next_cursor ?? null);
        setHasMore(Boolean(payload.has_more));
        setTotalCount(numberOrNull(payload.total_count) ?? knownCommentCount);
        setPublicCount(numberOrNull(payload.public_count));
      })
      .catch((caught) => {
        if (!isActive) {
          return;
        }

        setError(getApiError(caught));
      })
      .finally(() => {
        if (isActive) {
          setIsLoading(false);
        }
      });

    return () => {
      isActive = false;
    };
  }, [fetchComments, knownCommentCount]);

  const loadMore = useCallback(async () => {
    if (!hasMore || isLoading || isLoadingMore) {
      return;
    }

    setIsLoadingMore(true);
    setError(null);

    try {
      const payload = await fetchComments(cursor);

      setComments((current) => mergeComments(current, normalizeCommentList(payload.comments)));
      setCursor(payload.next_cursor ?? null);
      setHasMore(Boolean(payload.has_more));
      setTotalCount(numberOrNull(payload.total_count) ?? knownCommentCount);
      setPublicCount(numberOrNull(payload.public_count));
    } catch (caught) {
      setError(getApiError(caught));
    } finally {
      setIsLoadingMore(false);
    }
  }, [cursor, fetchComments, hasMore, isLoading, isLoadingMore, knownCommentCount]);

  const onScroll = useCallback((event) => {
    const viewport = event.currentTarget;
    const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;

    if (remaining < 120) {
      loadMore();
    }
  }, [loadMore]);

  const visibleTotal = Math.max(totalCount ?? publicCount ?? comments.length, comments.length);
  const hasUnavailablePublicComments = !isLoading &&
    !error &&
    comments.length === 0 &&
    (totalCount ?? 0) > 0 &&
    (publicCount ?? 0) === 0;
  const statusText = comments.length > 0
    ? copy.commentsVisibleCount(comments.length, visibleTotal)
    : "";
  const footerStatusText = isLoading ? copy.loadingComments : statusText || copy.commentsEnd;

  return (
    <div
      className="absolute inset-0 z-40 grid place-items-center px-5 py-5 backdrop-blur-[12px]"
      onMouseDown={onClose}
      role="presentation"
      style={buildPostCommentsBackdropStyle(chrome)}
    >
      <section
        aria-label={copy.commentsPanel}
        aria-modal="true"
        className="grid h-[min(74vh,38rem)] w-[min(86vw,36rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-[1.15rem] border shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        style={buildPostCommentsShellStyle(chrome)}
      >
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4" style={buildPostCommentsHeaderStyle(chrome)}>
          <div className="min-w-0">
            <h3 className="truncate text-lg font-black" style={{ color: chrome.text }}>
              {copy.commentsPanel}
            </h3>
            <div className="truncate text-xs font-semibold" style={{ color: chrome.muted }}>
              {statusText || getPlatformLabel(result.platform, copy)}
            </div>
          </div>
          <button
            aria-label={copy.closeDetails}
            className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border transition hover:scale-[1.03]"
            onClick={onClose}
            style={buildPostCloseButtonStyle(chrome)}
            type="button"
          >
            <ClearIcon />
          </button>
        </div>

        <FloatingScrollArea
          className="min-h-0"
          contentClassName="px-4 py-4"
          onScroll={onScroll}
          theme={{ accent: chrome.accent }}
        >
          <div className="grid gap-3">
            {isLoading ? (
              <PostCommentsState chrome={chrome} isLoading text={copy.loadingComments} />
            ) : null}

            {!isLoading && error ? (
              <PostCommentsError chrome={chrome} copy={copy} error={error} onRetry={() => fetchComments(null)
                .then((payload) => {
                  setComments(normalizeCommentList(payload.comments));
                  setCursor(payload.next_cursor ?? null);
                  setHasMore(Boolean(payload.has_more));
                  setTotalCount(numberOrNull(payload.total_count) ?? knownCommentCount);
                  setPublicCount(numberOrNull(payload.public_count));
                  setError(null);
                })
                .catch((caught) => setError(getApiError(caught)))} />
            ) : null}

            {!isLoading && !error && comments.length === 0 ? (
              <PostCommentsState chrome={chrome} text={hasUnavailablePublicComments ? copy.commentsUnavailablePartial : copy.noComments} />
            ) : null}

            {comments.map((comment) => (
              <PostCommentCard
                chrome={chrome}
                comment={comment}
                copy={copy}
                key={comment.id}
                language={language}
                onCopyComment={onCopyComment}
              />
            ))}

            {isLoadingMore ? (
              <PostCommentsState chrome={chrome} compact isLoading text={copy.loadingMoreComments} />
            ) : null}
          </div>
        </FloatingScrollArea>

        <div className="flex items-center justify-between gap-3 border-t px-5 py-3 text-xs font-semibold" style={buildPostCommentsHeaderStyle(chrome)}>
          <span className="min-w-0 truncate" style={{ color: chrome.muted }}>
            {footerStatusText}
          </span>
          {hasMore ? (
            <button
              className="shrink-0 cursor-pointer rounded-full border px-3 py-1.5 text-xs font-bold transition hover:scale-[1.03]"
              disabled={isLoadingMore}
              onClick={loadMore}
              style={buildPostCommentsActionStyle(chrome)}
              type="button"
            >
              {isLoadingMore ? (
                <span className="inline-flex items-center gap-2">
                  <span className="block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  {copy.loadingMoreComments}
                </span>
              ) : copy.loadMoreComments}
            </button>
          ) : (
            <span className="shrink-0" style={{ color: chrome.muted }}>
              {isLoading ? "" : copy.commentsEnd}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

function PostCommentCard({ chrome, comment, copy, language, onCopyComment }) {
  const text = comment.text || (comment.has_voice ? copy.voiceComment : "");
  const copyable = Boolean(text.trim());

  return (
    <div className="grid gap-2 rounded-[0.95rem] border px-4 py-3" style={buildPostCommentCardStyle(chrome, copyable)}>
      <button
        className={`grid w-full gap-3 text-left transition ${copyable ? "cursor-pointer hover:-translate-y-0.5" : "cursor-default"}`}
        disabled={!copyable}
        onClick={(event) => onCopyComment(text, copy.copiedComment, event)}
        title={copyable ? copy.copyComment : undefined}
        type="button"
      >
        <div className="flex min-w-0 items-start gap-3">
          <CommentAvatar chrome={chrome} comment={comment} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-black" style={{ color: chrome.text }}>
                {comment.author_name}
              </span>
              <span className="shrink-0 text-[11px] font-semibold" style={{ color: chrome.muted }}>
                {formatCommentTime(comment.created_at, language)}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] font-semibold" style={{ color: chrome.muted }}>
              {comment.ip_loc ? <span className="truncate">{comment.ip_loc}</span> : null}
              <span className="shrink-0">{formatCompactNumber(comment.like_count, language)} {copy.likes}</span>
            </div>
          </div>
        </div>

        <div className="whitespace-pre-wrap break-words text-[14px] font-medium leading-6" style={{ color: chrome.text }}>
          {text || copy.noContent}
        </div>
      </button>

      {comment.replies.length > 0 ? (
        <div className="grid gap-2 rounded-[0.75rem] px-3 py-2" style={buildPostCommentRepliesStyle(chrome)}>
          {comment.replies.map((reply) => (
            <button
              className="grid cursor-pointer gap-1 text-left text-xs leading-5 transition hover:opacity-75"
              key={reply.id}
              onClick={(event) => onCopyComment(reply.text || copy.voiceComment, copy.copiedComment, event)}
              title={copy.copyComment}
              type="button"
            >
              <span className="font-bold" style={{ color: chrome.text }}>{reply.author_name}</span>
              <span className="break-words" style={{ color: chrome.muted }}>{reply.text || copy.voiceComment}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CommentAvatar({ chrome, comment }) {
  const [hasImageError, setHasImageError] = useState(false);
  const avatarUrl = proxiedCommentAvatarUrl(comment.avatar_url);

  useEffect(() => {
    setHasImageError(false);
  }, [comment.avatar_url]);

  if (avatarUrl && !hasImageError) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img
        alt=""
        className="size-10 shrink-0 rounded-full border object-cover"
        draggable={false}
        onError={() => setHasImageError(true)}
        referrerPolicy="no-referrer"
        src={avatarUrl}
        style={{ borderColor: chrome.divider }}
      />
    );
  }

  return (
    <div className="grid size-10 shrink-0 place-items-center rounded-full border text-xs font-black" style={buildPostMetricIconStyle(chrome)}>
      {String(comment.author_name || "?").trim()[0]?.toUpperCase() || "?"}
    </div>
  );
}

function proxiedCommentAvatarUrl(value) {
  const url = String(value || "").trim();

  if (!url) {
    return "";
  }

  return isInstagramImageUrl(url)
    ? apiUrl(`/api/v1/instagram/avatar?url=${encodeURIComponent(url)}`)
    : url;
}

function isInstagramImageUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();

    return (
      host === "instagram.com" ||
      host.endsWith(".instagram.com") ||
      host === "cdninstagram.com" ||
      host.endsWith(".cdninstagram.com") ||
      host === "fbcdn.net" ||
      host.endsWith(".fbcdn.net") ||
      host === "fbsbx.com" ||
      host.endsWith(".fbsbx.com")
    );
  } catch {
    return false;
  }
}

function PostCommentsState({ chrome, compact = false, isLoading = false, text }) {
  if (isLoading) {
    return (
      <div
        aria-live="polite"
        className={`rounded-[0.95rem] border px-5 text-center font-bold ${compact ? "py-3 text-xs" : "grid gap-4 py-6 text-sm"}`}
        role="status"
        style={buildPostCommentCardStyle(chrome, false)}
      >
        <div className={`items-center ${compact ? "flex justify-center gap-2" : "grid justify-items-center gap-3"}`}>
          <span
            aria-hidden="true"
            className={`${compact ? "size-4" : "size-8"} block animate-spin rounded-full border-2 border-current border-t-transparent`}
            style={{ color: chrome.accent }}
          />
          <span style={{ color: chrome.muted }}>{text}</span>
        </div>

        {!compact ? <PostCommentsLoadingSkeleton chrome={chrome} /> : null}
      </div>
    );
  }

  return (
    <div className={`grid place-items-center rounded-[0.95rem] border px-5 text-center font-bold ${compact ? "py-3 text-xs" : "py-10 text-sm"}`} style={buildPostCommentCardStyle(chrome, false)}>
      <span style={{ color: chrome.muted }}>{text}</span>
    </div>
  );
}

function PostCommentsLoadingSkeleton({ chrome }) {
  return (
    <div aria-hidden="true" className="grid gap-3">
      {[0, 1, 2].map((index) => (
        <div
          className="grid gap-3 rounded-[0.8rem] border p-3"
          key={index}
          style={{
            background: hexToRgba(chrome.accent, 0.035),
            borderColor: chrome.metricBorder,
          }}
        >
          <div className="flex items-center gap-3">
            <span
              className="size-9 shrink-0 animate-pulse rounded-full"
              style={{ background: hexToRgba(chrome.accent, 0.16) }}
            />
            <span className="grid min-w-0 flex-1 gap-2">
              <span
                className="h-3 w-[42%] animate-pulse rounded-full"
                style={{ background: hexToRgba(chrome.accent, 0.18) }}
              />
              <span
                className="h-2.5 w-[28%] animate-pulse rounded-full"
                style={{ background: hexToRgba(chrome.accent, 0.11) }}
              />
            </span>
          </div>
          <span
            className="h-3 w-[88%] animate-pulse rounded-full"
            style={{ background: hexToRgba(chrome.accent, 0.12) }}
          />
          <span
            className="h-3 w-[64%] animate-pulse rounded-full"
            style={{ background: hexToRgba(chrome.accent, 0.09) }}
          />
        </div>
      ))}
    </div>
  );
}

function PostCommentsError({ chrome, copy, error, onRetry }) {
  return (
    <div className="grid gap-3 rounded-[0.95rem] border px-5 py-5 text-sm font-bold" style={buildPostCommentCardStyle(chrome, false)}>
      <div style={{ color: chrome.text }}>{copy.commentsLoadFailed}</div>
      <div className="font-semibold" style={{ color: chrome.muted }}>{error.message}</div>
      <button
        className="justify-self-start rounded-full border px-3 py-1.5 text-xs font-bold"
        onClick={onRetry}
        style={buildPostCommentsActionStyle(chrome)}
        type="button"
      >
        {copy.retry}
      </button>
    </div>
  );
}

function MetricValue({ chrome, language, value }) {
  const text = formatFullNumber(value, language);
  const shouldMarquee = text.length > 9;

  return (
    <div className="min-w-0 whitespace-nowrap text-sm font-black leading-5" style={{ color: value == null ? chrome.muted : chrome.accent }} title={text}>
      {shouldMarquee ? (
        <span className="lm-metric-marquee inline-flex min-w-full">
          <span className="pr-6">{text}</span>
          <span aria-hidden="true" className="pr-6">{text}</span>
        </span>
      ) : (
        <span className="block truncate">{text}</span>
      )}
    </div>
  );
}

function MetricIcon({ copy, label }) {
  const icon = label === copy.likes
    ? "heart"
    : label === copy.comments
      ? "comment"
      : label === copy.views
        ? "play"
        : label === copy.shares
          ? "share"
          : "bookmark";

  if (icon === "heart") {
    return (
      <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
        <path d="M20.2 5.8c-1.7-1.8-4.4-1.8-6.1 0L12 7.9 9.9 5.8c-1.7-1.8-4.4-1.8-6.1 0-1.8 1.9-1.8 4.9 0 6.7L12 21l8.2-8.5c1.8-1.8 1.8-4.8 0-6.7Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      </svg>
    );
  }

  if (icon === "comment") {
    return (
      <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
        <path d="M20 11.6a7.5 7.5 0 0 1-8 7.4 8.8 8.8 0 0 1-3.3-.7L4 20l1.4-4.1A7.4 7.4 0 1 1 20 11.6Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
      </svg>
    );
  }

  if (icon === "play") {
    return (
      <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
        <path d="M8 5.8v12.4c0 .7.8 1.1 1.4.7l9.3-6.2c.5-.3.5-1.1 0-1.4L9.4 5.1C8.8 4.7 8 5.1 8 5.8Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
      </svg>
    );
  }

  if (icon === "share") {
    return (
      <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
        <path d="m20 4-8.6 16-1.6-7.2L4 10.2 20 4Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24">
      <path d="M7 4.8c0-1 .8-1.8 1.8-1.8h6.4c1 0 1.8.8 1.8 1.8V21l-5-3.2L7 21V4.8Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function displayTitle(info) {
  const title = String(info.title || "").trim();
  const body = String(info.body || "").trim();

  return title && title !== body ? title : "";
}

function displayAuthorName(info, result) {
  const author = String(info.author || "").trim();
  const handle = displayAuthorHandle(info, result);

  if (author && handle && author !== handle) {
    return author;
  }

  if (author) {
    return author;
  }

  return handle ? `@${handle.replace(/^@+/, "")}` : "";
}

function displayAuthorHandle(info, result) {
  return String(info.author_handle || result.creator_handle || "").trim().replace(/^@+/, "");
}

function clampAssetIndex(index, assetCount) {
  const numericIndex = Number(index);

  if (!assetCount || !Number.isFinite(numericIndex)) {
    return 0;
  }

  return Math.max(0, Math.min(assetCount - 1, Math.trunc(numericIndex)));
}

function canOpenPostComments(result) {
  return Boolean(result?.platform && result?.canonical_url);
}

function normalizeProfilePostList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((post) => post && typeof post === "object" && post.id)
    .map((post) => ({
      ...post,
      id: String(post.id),
    }));
}

function mergeProfilePosts(currentPosts, nextPosts) {
  const merged = [];
  const seen = new Set();

  for (const post of [...normalizeProfilePostList(currentPosts), ...normalizeProfilePostList(nextPosts)]) {
    if (seen.has(post.id)) {
      continue;
    }

    seen.add(post.id);
    merged.push(post);
  }

  return merged;
}

function mergeUniqueIds(currentIds, nextIds) {
  return [
    ...new Set([
      ...(Array.isArray(currentIds) ? currentIds : []),
      ...(Array.isArray(nextIds) ? nextIds : []),
    ].map((id) => String(id || "").trim()).filter(Boolean)),
  ];
}

function createLocalProfileDownloadJob(posts) {
  const now = new Date().toISOString();
  const postStatuses = Object.fromEntries(
    normalizeProfilePostList(posts).map((post) => [
      post.id,
      {
        post_id: post.id,
        status: "queued",
        message: "等待下载",
        updated_at: now,
      },
    ]),
  );

  return {
    job_id: "",
    status: "queued",
    phase: "queued",
    progress: {
      total_count: Object.keys(postStatuses).length,
      completed_count: 0,
      success_count: 0,
      partial_failed_count: 0,
      failed_count: 0,
    },
    post_statuses: postStatuses,
  };
}

function emptyProfilePostDetail() {
  return {
    isOpen: false,
    isLoading: false,
    result: null,
    error: null,
    post: null,
  };
}

function profilePostDetailPayloadResult(payload) {
  if (payload?.status === "completed" && payload.result && payload.result.mode !== "profile") {
    return payload.result;
  }

  return null;
}

function profileDownloadButtonLabel(copy, job) {
  const progress = job?.progress ?? {};
  const done = Number(progress.completed_count) || 0;
  const total = Number(progress.total_count) || 0;

  return total > 0 ? copy.profileDownloadProgress(done, total) : copy.pleaseWait;
}

function normalizeProfileDownloadStatus(value) {
  return ["queued", "downloading", "success", "partial_failed", "failed"].includes(value)
    ? value
    : "queued";
}

function profilePostDownloadStatusLabel(copy, status) {
  if (status === "success") {
    return copy.profileDownloadSuccess;
  }

  if (status === "partial_failed") {
    return copy.profileDownloadPartialFailed;
  }

  if (status === "failed") {
    return copy.profileDownloadFailed;
  }

  if (status === "downloading") {
    return copy.profileDownloadDownloading;
  }

  return copy.profileDownloadQueued;
}

function profilePostDownloadCardClass(status) {
  if (status === "downloading") {
    return "lm-profile-post-card-downloading";
  }

  if (status === "success") {
    return "lm-profile-post-card-success";
  }

  if (status === "partial_failed") {
    return "lm-profile-post-card-partial";
  }

  if (status === "failed") {
    return "lm-profile-post-card-failed";
  }

  return "";
}

function normalizeCommentList(value) {
  return Array.isArray(value)
    ? value.filter((comment) => comment && typeof comment === "object")
    : [];
}

function mergeComments(current, next) {
  const seen = new Set(current.map((comment) => comment.id));
  const merged = [...current];

  for (const comment of next) {
    if (!comment.id || seen.has(comment.id)) {
      continue;
    }

    seen.add(comment.id);
    merged.push(comment);
  }

  return merged;
}

function numberOrNull(value) {
  const number = Number(value);

  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatCommentTime(value, language = "zh") {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString(language === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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
    { key: "likes", label: copy.likes, value: metrics?.like_count },
    { key: "comments", label: copy.comments, value: metrics?.comment_count },
    { key: "views", label: copy.views, value: metrics?.view_count },
    { key: "shares", label: copy.shares, value: metrics?.share_count },
    { key: "favorites", label: copy.favorites, value: metrics?.save_count },
  ];
}

function formatFullNumber(value, language = "zh") {
  if (!Number.isFinite(value ?? NaN) || value == null || value < 0) {
    return "/";
  }

  return new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US").format(value);
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

function buildCohereSidebarStyle(theme) {
  return {
    backgroundColor: theme.colorMode === "dark" ? "rgba(7,24,41,0.74)" : "rgba(255,255,255,0.58)",
    borderColor: theme.panelBorder,
    boxShadow: theme.colorMode === "dark"
      ? "0 28px 70px rgba(0,0,0,0.24)"
      : "0 24px 60px rgba(33,33,33,0.06)",
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
    backgroundImage: theme.uiTheme === "cohere" ? theme.buttonGradient : theme.glassGradientSoft,
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

function buildCreatorButtonStyle(theme) {
  return {
    color: theme.bodyText,
    backgroundColor: hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.16 : 0.07),
    backgroundImage: theme.glassGradientSoft,
    borderColor: theme.border,
    boxShadow: `0 12px 24px ${hexToRgba(theme.accent, 0.08)}`,
    transition: themeTransition,
    ...buildActionInteractionVars(theme),
  };
}

function buildInfoBadgeStyle(theme) {
  return {
    color: theme.accentText,
    backgroundColor: theme.iconBackground,
    borderColor: theme.panelBorder,
    transition: themeTransition,
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

function buildAssetCardStyle(theme, isSelected) {
  return {
    color: theme.bodyText,
    backgroundColor: isSelected
      ? hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.18 : 0.1)
      : theme.cardBackground,
    backgroundImage: theme.cardGradient,
    borderColor: isSelected ? theme.borderStrong : theme.cardBorder,
    boxShadow: isSelected ? theme.selectedShadow : theme.cardShadow,
    transition: themeTransition,
  };
}

function buildProfilePostCardStyle(theme, isSelected, status) {
  const base = buildAssetCardStyle(theme, isSelected);

  if (status === "success") {
    return {
      ...base,
      "--lm-profile-post-flow-border": theme.colorMode === "dark" ? "rgba(134, 239, 172, 0.95)" : "rgba(34, 197, 94, 0.78)",
      "--lm-profile-post-flow-glow": theme.colorMode === "dark" ? "rgba(34, 197, 94, 0.24)" : "rgba(34, 197, 94, 0.18)",
      backgroundImage: `${theme.cardGradient}, linear-gradient(135deg, rgba(34, 197, 94, 0.72), rgba(187, 247, 208, 0.92), rgba(34, 197, 94, 0.62))`,
      borderColor: "transparent",
      boxShadow: `${base.boxShadow}, 0 0 0 1px ${theme.colorMode === "dark" ? "rgba(134, 239, 172, 0.22)" : "rgba(34, 197, 94, 0.18)"}, 0 18px 38px ${theme.colorMode === "dark" ? "rgba(34, 197, 94, 0.18)" : "rgba(34, 197, 94, 0.12)"}`,
    };
  }

  if (status === "partial_failed") {
    return {
      ...base,
      borderColor: theme.colorMode === "dark" ? "rgba(253, 230, 138, 0.74)" : "rgba(245, 158, 11, 0.6)",
    };
  }

  if (status === "failed") {
    return {
      ...base,
      borderColor: theme.colorMode === "dark" ? "rgba(251, 113, 133, 0.76)" : "rgba(244, 63, 94, 0.62)",
    };
  }

  if (status === "downloading") {
    return {
      ...base,
      "--lm-profile-post-flow-border": theme.colorMode === "dark" ? "rgba(244, 114, 182, 0.95)" : "rgba(214, 41, 118, 0.76)",
      "--lm-profile-post-flow-border-soft": theme.colorMode === "dark" ? "rgba(192, 132, 252, 0.78)" : "rgba(216, 180, 254, 0.74)",
      "--lm-profile-post-flow-glow": theme.colorMode === "dark" ? "rgba(214, 41, 118, 0.26)" : "rgba(214, 41, 118, 0.16)",
      backgroundImage: `${theme.cardGradient}, linear-gradient(90deg, var(--lm-profile-post-flow-border-soft), var(--lm-profile-post-flow-border), var(--lm-profile-post-flow-border-soft), var(--lm-profile-post-flow-border))`,
      borderColor: "transparent",
      boxShadow: `${base.boxShadow}, 0 20px 44px ${theme.colorMode === "dark" ? "rgba(214, 41, 118, 0.16)" : "rgba(214, 41, 118, 0.1)"}`,
    };
  }

  return base;
}

function buildProfilePostSelectionStyle(theme, isSelected) {
  return {
    color: isSelected ? theme.buttonText : "transparent",
    backgroundColor: isSelected
      ? theme.uiTheme === "cohere" ? theme.accent : hexToRgba(theme.accent, 0.9)
      : theme.colorMode === "dark" ? "rgba(7,24,41,0.54)" : "rgba(255,255,255,0.72)",
    borderColor: isSelected ? theme.accentStrong : theme.colorMode === "dark" ? "rgba(255,255,255,0.62)" : "rgba(33,33,33,0.3)",
    boxShadow: isSelected ? `0 8px 18px ${hexToRgba(theme.accent, 0.28)}` : "0 6px 16px rgba(15,23,42,0.14)",
  };
}

function buildProfilePostDownloadBadgeStyle(theme, status) {
  if (status === "success") {
    return {
      color: theme.colorMode === "dark" ? "#D7FBE8" : "#12633A",
      backgroundColor: theme.colorMode === "dark" ? "rgba(21, 128, 61, 0.78)" : "rgba(220, 252, 231, 0.92)",
      borderColor: theme.colorMode === "dark" ? "rgba(187, 247, 208, 0.36)" : "rgba(34, 197, 94, 0.34)",
    };
  }

  if (status === "partial_failed") {
    return {
      color: theme.colorMode === "dark" ? "#FEF3C7" : "#8A4B08",
      backgroundColor: theme.colorMode === "dark" ? "rgba(180, 83, 9, 0.78)" : "rgba(254, 243, 199, 0.94)",
      borderColor: theme.colorMode === "dark" ? "rgba(253, 230, 138, 0.38)" : "rgba(245, 158, 11, 0.36)",
    };
  }

  if (status === "failed") {
    return {
      color: theme.colorMode === "dark" ? "#FFE4E6" : "#9F1239",
      backgroundColor: theme.colorMode === "dark" ? "rgba(190, 18, 60, 0.8)" : "rgba(255, 228, 230, 0.94)",
      borderColor: theme.colorMode === "dark" ? "rgba(251, 113, 133, 0.4)" : "rgba(244, 63, 94, 0.36)",
    };
  }

  return {
    color: theme.accentText,
    backgroundColor: hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.68 : 0.16),
    borderColor: theme.border,
  };
}

function buildPostModalBackdropStyle(theme) {
  const accent = theme.accent ?? "#7b8aa1";

  return {
    background: theme.colorMode === "dark"
      ? `radial-gradient(circle at center, ${hexToRgba(accent, 0.14)}, rgba(3, 8, 17, 0.64) 72%)`
      : `radial-gradient(circle at center, ${hexToRgba(accent, 0.08)}, rgba(219, 233, 252, 0.46) 72%)`,
    transition: themeTransition,
  };
}

function buildPlatformPostShellStyle(chrome) {
  return {
    background: chrome.shellBackground,
    borderColor: chrome.shellBorder,
    boxShadow: chrome.shellShadow,
    color: chrome.text,
    transition: themeTransition,
  };
}

function buildPostCloseButtonStyle(chrome) {
  return {
    color: chrome.closeText,
    background: chrome.closeBackground,
    borderColor: chrome.divider,
    boxShadow: chrome.closeShadow,
    transition: themeTransition,
  };
}

function buildPostDownloadButtonStyle(chrome, disabled) {
  return {
    color: disabled ? chrome.muted : chrome.pillText,
    background: disabled ? hexToRgba(chrome.accent, 0.04) : chrome.pillBackground,
    borderColor: chrome.divider,
    boxShadow: disabled ? "none" : `0 10px 24px ${hexToRgba(chrome.accent, 0.12)}`,
    opacity: disabled ? 0.56 : 1,
    transition: themeTransition,
  };
}

function buildPostDownloadMenuStyle(chrome) {
  return {
    color: chrome.text,
    background: chrome.contentBackground,
    borderColor: chrome.divider,
    boxShadow: `0 22px 54px ${hexToRgba(chrome.accent, 0.18)}, 0 14px 34px rgba(4,10,20,0.18)`,
  };
}

function buildPostDownloadMenuItemStyle(chrome) {
  return {
    color: chrome.text,
    background: chrome.metricBackground,
  };
}

function buildPostPlatformPillStyle(chrome) {
  return {
    color: chrome.pillText,
    background: chrome.pillBackground,
    border: `1px solid ${chrome.divider}`,
  };
}

function buildPostTagStyle(chrome) {
  return {
    color: chrome.tagText,
    background: chrome.tagBackground,
    border: `1px solid ${chrome.tagBorder}`,
  };
}

function buildPostMediaBadgeStyle(chrome) {
  return {
    color: chrome.mediaText,
    background: chrome.mediaBadgeBackground,
    border: `1px solid ${chrome.mediaBorder}`,
  };
}

function buildPostMediaFrameStyle(chrome) {
  return {
    background: chrome.mediaFrameBackground,
    borderColor: chrome.mediaBorder,
    boxShadow: chrome.mediaShadow,
  };
}

function buildPostMediaNavStyle(chrome) {
  return {
    color: chrome.mediaText,
    background: chrome.mediaBadgeBackground,
    borderColor: chrome.mediaBorder,
  };
}

function buildPostMediaCounterStyle(chrome) {
  return {
    color: chrome.mediaText,
    background: chrome.mediaBadgeBackground,
    borderColor: chrome.mediaBorder,
  };
}

function buildPostResourceIconStyle(chrome, isActive) {
  return {
    color: isActive ? chrome.mediaText : chrome.accent,
    background: isActive ? hexToRgba(chrome.accent, 0.22) : chrome.metricIconBackground,
    borderColor: isActive ? hexToRgba(chrome.accent, 0.38) : chrome.mediaBorder,
  };
}

function buildResourcePreviewShellStyle(chrome) {
  return {
    background: chrome.modalPanelBackground ?? chrome.contentBackground,
    borderColor: chrome.mediaBorder,
    color: chrome.text,
  };
}

function buildResourcePreviewHeaderStyle(chrome) {
  return {
    background: chrome.mediaBadgeBackground,
    borderColor: chrome.mediaBorder,
  };
}

function buildResourcePreviewButtonStyle(chrome) {
  return {
    color: chrome.mediaText,
    background: chrome.mediaBadgeBackground,
    borderColor: chrome.mediaBorder,
  };
}

function buildResourceAudioStyle(chrome) {
  return {
    background: chrome.contentBackground,
    borderColor: chrome.mediaBorder,
  };
}

function buildPostMetricStyle(chrome) {
  return {
    background: chrome.metricBackground,
    border: `1px solid ${chrome.metricBorder}`,
  };
}

function buildPostMetricButtonStyle(chrome) {
  return {
    ...buildPostMetricStyle(chrome),
    color: chrome.text,
  };
}

function buildPostMetricIconStyle(chrome) {
  return {
    color: chrome.accent,
    background: chrome.metricIconBackground,
  };
}

function buildPostAudioIconStyle(chrome) {
  return {
    color: chrome.accent,
    background: chrome.metricIconBackground,
    borderColor: chrome.mediaBorder,
  };
}

function buildPostToastStyle(chrome) {
  const isDark = chrome.colorMode === "dark";

  return {
    color: chrome.text,
    background: isDark ? hexToRgba(chrome.accent, 0.14) : "rgba(255,255,255,0.58)",
    borderColor: isDark ? chrome.divider : "rgba(255,255,255,0.72)",
    boxShadow: isDark
      ? `0 18px 42px ${hexToRgba(chrome.accent, 0.2)}, inset 0 1px 0 rgba(255,255,255,0.08)`
      : `0 18px 42px ${hexToRgba(chrome.accent, 0.16)}, inset 0 1px 0 rgba(255,255,255,0.78)`,
    WebkitBackdropFilter: "blur(22px) saturate(1.35)",
    backdropFilter: "blur(22px) saturate(1.35)",
  };
}

function buildPostCommentsShellStyle(chrome) {
  return {
    background: chrome.contentBackground,
    borderColor: chrome.divider,
    boxShadow: `0 26px 70px ${hexToRgba(chrome.accent, 0.18)}, 0 18px 42px rgba(4,10,20,0.22)`,
    color: chrome.text,
  };
}

function buildPostCommentsBackdropStyle(chrome) {
  return {
    background: chrome.colorMode === "dark"
      ? `radial-gradient(circle at center, ${hexToRgba(chrome.accent, 0.14)}, rgba(4,10,20,0.54) 72%)`
      : `radial-gradient(circle at center, ${hexToRgba(chrome.accent, 0.08)}, rgba(4,10,20,0.26) 72%)`,
  };
}

function buildPostCommentsHeaderStyle(chrome) {
  return {
    background: hexToRgba(chrome.accent, 0.06),
    borderColor: chrome.divider,
  };
}

function buildPostCommentCardStyle(chrome, isCopyable) {
  return {
    color: chrome.text,
    background: isCopyable ? chrome.metricBackground : hexToRgba(chrome.accent, 0.04),
    borderColor: chrome.metricBorder,
  };
}

function buildPostCommentRepliesStyle(chrome) {
  return {
    background: hexToRgba(chrome.accent, 0.07),
    border: `1px solid ${chrome.metricBorder}`,
  };
}

function buildPostCommentsActionStyle(chrome) {
  return {
    color: chrome.text,
    background: chrome.metricIconBackground,
    borderColor: chrome.metricBorder,
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
  const isCohere = theme.uiTheme === "cohere";

  return {
    color: isActive ? theme.buttonText : theme.mutedText,
    backgroundColor: isActive ? hexToRgba(theme.accent, theme.colorMode === "dark" ? 0.2 : 0.12) : "transparent",
    backgroundImage: isActive && isCohere ? theme.buttonGradient : undefined,
    boxShadow: isActive ? theme.buttonShadow : "none",
    transition: themeTransition,
  };
}

function buildActionInteractionVars(theme) {
  const cohereHoverGradient = theme.colorMode === "dark"
    ? "linear-gradient(135deg, #eeece7 0%, #ffffff 100%)"
    : "linear-gradient(135deg, #003c33 0%, #17171c 100%)";

  return {
    "--lm-action-hover-bg": hexToRgba(theme.accent, 0.18),
    "--lm-action-hover-border": theme.borderStrong ?? theme.border,
    "--lm-action-hover-shadow": theme.buttonShadow,
    "--lm-action-active-bg": hexToRgba(theme.accent, 0.24),
    "--lm-action-active-shadow": `0 8px 18px ${hexToRgba(theme.accent, 0.18)}`,
    "--lm-action-hover-gradient": theme.uiTheme === "cohere" ? cohereHoverGradient : undefined,
    "--lm-action-active-gradient": theme.uiTheme === "cohere" ? cohereHoverGradient : undefined,
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

function triggerBrowserBlobDownload(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = filename || "download.zip";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function filenameFromDisposition(value) {
  const text = String(value || "");
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(text);

  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      // Ignore malformed header values.
    }
  }

  const fallbackMatch = /filename="([^"]+)"/i.exec(text);

  return fallbackMatch ? fallbackMatch[1] : "";
}

function getPlatformLabel(platform, copy = copyByLanguage.zh) {
  return platform ? copy.platformLabels?.[platform] ?? platformLabels[platform] ?? platform : copy.publicPlatform;
}

function platformMediaLabel(platform, copy = copyByLanguage.zh) {
  if (platform === "xiaoyuzhou") {
    return copy.audio;
  }

  if (["youtube", "tiktok", "douyin", "kuaishou", "acfun", "bilibili", "facebook", "pinterest", "pornhub"].includes(platform)) {
    return copy.video;
  }

  return copy.image;
}

function assetMediaLabel(asset, copy = copyByLanguage.zh) {
  if (asset?.media_type === "video") {
    return copy.video;
  }

  if (asset?.media_type === "audio") {
    return copy.audio;
  }

  if (asset?.media_type === "text") {
    return copy.text;
  }

  return copy.image;
}

function getPostChrome(platform, theme) {
  const isDark = theme.colorMode === "dark";
  const accent = theme.accent ?? "#7b8aa1";
  const accentStrong = theme.accentStrong ?? accent;
  const accentText = theme.accentText ?? (isDark ? "#f0f6ff" : "#334155");
  const base = isDark
    ? {
        colorMode: "dark",
        shellBackground: `linear-gradient(135deg, ${hexToRgba(accent, 0.12)} 0%, rgba(13,24,42,0.96) 46%, rgba(7,13,24,0.98) 100%)`,
        shellBorder: theme.borderStrong ?? theme.border ?? "rgba(180,207,240,0.22)",
        shellShadow: theme.panelShadow ?? `0 30px 80px ${hexToRgba(accent, 0.18)}, 0 18px 44px rgba(0,0,0,0.36)`,
        contentBackground: "linear-gradient(135deg, rgba(18,31,52,0.94) 0%, rgba(8,15,28,0.96) 100%)",
        modalPanelBackground: "linear-gradient(135deg, rgba(16,28,48,0.92) 0%, rgba(7,14,27,0.9) 100%)",
        mediaBackground: `linear-gradient(135deg, ${hexToRgba(accent, 0.17)} 0%, rgba(12,22,39,0.96) 46%, rgba(5,10,20,0.98) 100%)`,
        mediaFrameBackground: "rgba(4,8,16,0.96)",
        mediaBadgeBackground: hexToRgba(accent, 0.14),
        mediaBorder: theme.borderStrong ?? theme.border ?? "rgba(180,207,240,0.22)",
        mediaShadow: `0 24px 58px rgba(0,0,0,0.36), 0 14px 32px ${hexToRgba(accent, 0.14)}`,
        mediaText: theme.titleText ?? "#f4f8ff",
        mediaLabel: "post preview",
        contentLabel: "post",
        surfaceLabel: "Public post",
        text: theme.bodyText ?? "#eaf1fb",
        muted: theme.mutedText ?? "#a6b4c8",
        divider: theme.panelBorder ?? "rgba(180,207,240,0.22)",
        accent,
        avatarRing: `linear-gradient(135deg, ${accent} 0%, ${accentStrong} 100%)`,
        avatarFill: "rgba(7,14,27,0.96)",
        avatarText: accentText,
        pillBackground: hexToRgba(accent, 0.14),
        pillText: accentText,
        tagBackground: hexToRgba(accent, 0.1),
        tagBorder: hexToRgba(accent, 0.22),
        tagText: accentText,
        metricBackground: hexToRgba(accent, 0.075),
        metricBorder: theme.border ?? "rgba(180,207,240,0.18)",
        metricIconBackground: hexToRgba(accent, 0.14),
        closeBackground: theme.modalButtonBackground ?? "rgba(31,47,73,0.78)",
        closeText: theme.modalButtonText ?? "#f0f6ff",
        closeShadow: "none",
        audioBackground: `linear-gradient(135deg, ${hexToRgba(accent, 0.18)} 0%, rgba(8,15,28,0.92) 100%)`,
        previewBackdropOverlay: `radial-gradient(circle at center, ${hexToRgba(accent, 0.18)}, rgba(4,10,20,0.74) 72%)`,
        previewBackdropVeil: `linear-gradient(135deg, ${hexToRgba(accent, 0.24)} 0%, rgba(7,14,27,0.34) 46%, rgba(3,8,17,0.78) 100%)`,
      }
    : {
        colorMode: "light",
        shellBackground: "#ffffff",
        shellBorder: "rgba(15, 23, 42, 0.12)",
        shellShadow: "0 30px 80px rgba(15, 23, 42, 0.22)",
        contentBackground: "#ffffff",
        mediaBackground: "linear-gradient(135deg, #f4f6f9 0%, #eef1f7 100%)",
        mediaFrameBackground: "#f8fafc",
        mediaBadgeBackground: "rgba(255,255,255,0.78)",
        mediaBorder: "rgba(15, 23, 42, 0.1)",
        mediaShadow: "0 22px 48px rgba(15, 23, 42, 0.18)",
        mediaText: "#223049",
        mediaLabel: "post preview",
        contentLabel: "post",
        surfaceLabel: "Public post",
        text: "#182235",
        muted: "#718096",
        divider: "rgba(15, 23, 42, 0.1)",
        accent,
        avatarRing: `linear-gradient(135deg, ${accent} 0%, ${accentStrong} 100%)`,
        avatarFill: "#ffffff",
        avatarText: accentText,
        pillBackground: hexToRgba(accent, 0.08),
        pillText: accentText,
        tagBackground: hexToRgba(accent, 0.08),
        tagBorder: hexToRgba(accent, 0.16),
        tagText: accentText,
        metricBackground: "rgba(248, 250, 252, 0.86)",
        metricBorder: "rgba(15, 23, 42, 0.06)",
        metricIconBackground: hexToRgba(accent, 0.1),
        closeBackground: "rgba(255,255,255,0.82)",
        closeText: accentText,
        closeShadow: "0 10px 24px rgba(15,23,42,0.1)",
        audioBackground: `linear-gradient(135deg, ${hexToRgba(accent, 0.16)} 0%, rgba(255,255,255,0.9) 100%)`,
      };

  const platformChrome = {
    instagram: {
      mediaBackground: "linear-gradient(135deg, #fff7e8 0%, #fff 28%, #f9e9ff 62%, #e8efff 100%)",
      mediaLabel: "Instagram",
      surfaceLabel: "Feed post",
      accent: "#d62976",
      avatarRing: "conic-gradient(from 210deg, #feda75, #fa7e1e, #d62976, #962fbf, #4f5bd5, #feda75)",
      pillBackground: "linear-gradient(135deg, rgba(254,218,117,0.28), rgba(214,41,118,0.14), rgba(79,91,213,0.14))",
      tagText: "#00376b",
      tagBackground: "rgba(0, 55, 107, 0.07)",
      tagBorder: "rgba(0, 55, 107, 0.12)",
      metricIconBackground: "rgba(214, 41, 118, 0.09)",
    },
    tiktok: {
      shellBackground: "#08090d",
      shellBorder: "rgba(37,244,238,0.26)",
      contentBackground: "#0d0f16",
      mediaBackground: "linear-gradient(145deg, #07080d 0%, #11131c 52%, #1b0d16 100%)",
      mediaFrameBackground: "#050507",
      mediaBadgeBackground: "rgba(255,255,255,0.08)",
      mediaBorder: "rgba(255,255,255,0.14)",
      mediaText: "#f5fbff",
      mediaLabel: "TikTok",
      surfaceLabel: "For You",
      text: "#f7f8fb",
      muted: "#9ba6b7",
      divider: "rgba(255,255,255,0.1)",
      accent: "#25f4ee",
      avatarRing: "linear-gradient(135deg, #25f4ee 0%, #ffffff 50%, #fe2c55 100%)",
      avatarFill: "#0d0f16",
      avatarText: "#ffffff",
      pillBackground: "rgba(37,244,238,0.12)",
      pillText: "#b8fffc",
      tagBackground: "rgba(254,44,85,0.12)",
      tagBorder: "rgba(254,44,85,0.22)",
      tagText: "#ff9aad",
      metricBackground: "rgba(255,255,255,0.055)",
      metricBorder: "rgba(255,255,255,0.08)",
      metricIconBackground: "rgba(37,244,238,0.12)",
      closeBackground: "rgba(255,255,255,0.08)",
      closeText: "#ffffff",
      closeShadow: "none",
      audioBackground: "linear-gradient(135deg, rgba(37,244,238,0.18), rgba(254,44,85,0.16))",
    },
    douyin: {
      shellBackground: "#08090d",
      shellBorder: "rgba(37,244,238,0.26)",
      contentBackground: "#0c0e15",
      mediaBackground: "linear-gradient(145deg, #05060a 0%, #11151c 50%, #190b13 100%)",
      mediaFrameBackground: "#050507",
      mediaBadgeBackground: "rgba(255,255,255,0.08)",
      mediaBorder: "rgba(255,255,255,0.14)",
      mediaText: "#f5fbff",
      mediaLabel: "Douyin",
      surfaceLabel: "Recommend",
      text: "#f7f8fb",
      muted: "#9ba6b7",
      divider: "rgba(255,255,255,0.1)",
      accent: "#25f4ee",
      avatarRing: "linear-gradient(135deg, #25f4ee 0%, #ffffff 50%, #fe2c55 100%)",
      avatarFill: "#0c0e15",
      avatarText: "#ffffff",
      pillBackground: "rgba(37,244,238,0.12)",
      pillText: "#b8fffc",
      tagBackground: "rgba(254,44,85,0.12)",
      tagBorder: "rgba(254,44,85,0.22)",
      tagText: "#ff9aad",
      metricBackground: "rgba(255,255,255,0.055)",
      metricBorder: "rgba(255,255,255,0.08)",
      metricIconBackground: "rgba(37,244,238,0.12)",
      closeBackground: "rgba(255,255,255,0.08)",
      closeText: "#ffffff",
      closeShadow: "none",
      audioBackground: "linear-gradient(135deg, rgba(37,244,238,0.18), rgba(254,44,85,0.16))",
    },
    twitter: {
      shellBackground: "#000000",
      shellBorder: "rgba(239,243,244,0.16)",
      contentBackground: "#000000",
      mediaBackground: "linear-gradient(135deg, #050505 0%, #10151d 100%)",
      mediaFrameBackground: "#0b0f14",
      mediaBadgeBackground: "rgba(29,155,240,0.14)",
      mediaBorder: "rgba(239,243,244,0.14)",
      mediaText: "#f7f9f9",
      mediaLabel: "X",
      surfaceLabel: "Post",
      text: "#f7f9f9",
      muted: "#8b98a5",
      divider: "rgba(239,243,244,0.14)",
      accent: "#1d9bf0",
      avatarRing: "linear-gradient(135deg, #1d9bf0, #94d4ff)",
      avatarFill: "#111820",
      avatarText: "#f7f9f9",
      pillBackground: "rgba(29,155,240,0.13)",
      pillText: "#8ecdf8",
      tagBackground: "rgba(29,155,240,0.12)",
      tagBorder: "rgba(29,155,240,0.22)",
      tagText: "#1d9bf0",
      metricBackground: "rgba(239,243,244,0.06)",
      metricBorder: "rgba(239,243,244,0.08)",
      metricIconBackground: "rgba(29,155,240,0.13)",
      closeBackground: "rgba(239,243,244,0.08)",
      closeText: "#f7f9f9",
      closeShadow: "none",
    },
    youtube: {
      shellBackground: "#ffffff",
      shellBorder: "rgba(15,23,42,0.1)",
      shellShadow: "0 30px 80px rgba(15,23,42,0.2), 0 16px 38px rgba(255,0,0,0.1)",
      contentBackground: "#ffffff",
      modalPanelBackground: "rgba(255,255,255,0.9)",
      mediaBackground: "linear-gradient(135deg, #fff1f3 0%, #ffffff 48%, #f7f7f7 100%)",
      mediaFrameBackground: "#0f0f0f",
      mediaBadgeBackground: "rgba(255,255,255,0.86)",
      mediaBorder: "rgba(15,23,42,0.1)",
      mediaText: "#0f0f0f",
      mediaLabel: "YouTube",
      surfaceLabel: "Watch",
      text: "#0f0f0f",
      muted: "#606060",
      divider: "rgba(15,23,42,0.1)",
      accent: "#ff0000",
      avatarRing: "linear-gradient(135deg, #ff0000, #ff6b6b)",
      avatarFill: "#ffffff",
      avatarText: "#cc0000",
      pillBackground: "rgba(255,0,0,0.08)",
      pillText: "#cc0000",
      tagBackground: "rgba(62,166,255,0.14)",
      tagBorder: "rgba(62,166,255,0.22)",
      tagText: "#065fd4",
      metricBackground: "rgba(247,247,247,0.92)",
      metricBorder: "rgba(15,23,42,0.06)",
      metricIconBackground: "rgba(255,0,0,0.09)",
      closeBackground: "rgba(242,242,242,0.9)",
      closeText: "#0f0f0f",
      closeShadow: "0 10px 24px rgba(15,23,42,0.08)",
      audioBackground: "linear-gradient(135deg, rgba(255,0,0,0.12), rgba(255,255,255,0.92))",
      previewBackdropOverlay: "radial-gradient(circle at center, rgba(255,255,255,0.86), rgba(255,244,246,0.78) 52%, rgba(248,249,250,0.92) 100%)",
      previewBackdropVeil: "linear-gradient(135deg, rgba(255,0,0,0.08) 0%, rgba(255,255,255,0.42) 46%, rgba(15,23,42,0.08) 100%)",
    },
    xiaohongshu: {
      mediaBackground: "linear-gradient(135deg, #fff5f7 0%, #ffffff 48%, #f5f5f5 100%)",
      mediaLabel: "Xiaohongshu",
      surfaceLabel: "Note",
      accent: "#ff2442",
      avatarRing: "linear-gradient(135deg, #ff2442, #ff9aa8)",
      pillBackground: "rgba(255,36,66,0.1)",
      pillText: "#d91f3b",
      tagBackground: "rgba(255,36,66,0.08)",
      tagBorder: "rgba(255,36,66,0.14)",
      tagText: "#d91f3b",
      metricIconBackground: "rgba(255,36,66,0.1)",
    },
    kuaishou: {
      mediaBackground: "linear-gradient(135deg, #fff3e8 0%, #fff 48%, #ffe7f0 100%)",
      mediaLabel: "Kuaishou",
      surfaceLabel: "Work",
      accent: "#ff5000",
      avatarRing: "linear-gradient(135deg, #ff5000, #fe3666)",
      pillBackground: "rgba(255,80,0,0.1)",
      pillText: "#cf4508",
      tagBackground: "rgba(255,80,0,0.08)",
      tagBorder: "rgba(255,80,0,0.14)",
      tagText: "#cf4508",
      metricIconBackground: "rgba(255,80,0,0.1)",
    },
    acfun: {
      mediaBackground: "linear-gradient(135deg, #fff0f2 0%, #ffffff 48%, #eef7ff 100%)",
      mediaLabel: "AcFun",
      surfaceLabel: "Video",
      accent: "#fd4c5d",
      avatarRing: "linear-gradient(135deg, #fd4c5d, #36a7ff)",
      pillBackground: "rgba(253,76,93,0.1)",
      pillText: "#d93c4b",
      tagBackground: "rgba(54,167,255,0.1)",
      tagBorder: "rgba(54,167,255,0.16)",
      tagText: "#1f7fc6",
      metricIconBackground: "rgba(253,76,93,0.1)",
    },
    bilibili: {
      mediaBackground: "linear-gradient(135deg, #eaf8ff 0%, #ffffff 48%, #f3f7ff 100%)",
      mediaLabel: "Bilibili",
      surfaceLabel: "Video",
      accent: "#00aeec",
      avatarRing: "linear-gradient(135deg, #00aeec, #fb7299)",
      pillBackground: "rgba(0,174,236,0.1)",
      pillText: "#008ac0",
      tagBackground: "rgba(0,174,236,0.08)",
      tagBorder: "rgba(0,174,236,0.14)",
      tagText: "#008ac0",
      metricIconBackground: "rgba(0,174,236,0.1)",
    },
    facebook: {
      mediaBackground: "linear-gradient(135deg, #edf4ff 0%, #ffffff 54%, #eef2ff 100%)",
      mediaLabel: "Facebook",
      surfaceLabel: "Post",
      accent: "#1877f2",
      avatarRing: "linear-gradient(135deg, #1877f2, #7db4ff)",
      pillBackground: "rgba(24,119,242,0.1)",
      pillText: "#1666d0",
      tagBackground: "rgba(24,119,242,0.08)",
      tagBorder: "rgba(24,119,242,0.14)",
      tagText: "#1666d0",
      metricIconBackground: "rgba(24,119,242,0.1)",
    },
    pinterest: {
      mediaBackground: "linear-gradient(135deg, #fff0f4 0%, #ffffff 46%, #ffeef2 100%)",
      mediaLabel: "Pinterest",
      surfaceLabel: "Pin",
      accent: "#e60023",
      avatarRing: "linear-gradient(135deg, #e60023, #ff7a95)",
      pillBackground: "rgba(230,0,35,0.1)",
      pillText: "#c1122c",
      tagBackground: "rgba(230,0,35,0.08)",
      tagBorder: "rgba(230,0,35,0.16)",
      tagText: "#c1122c",
      metricIconBackground: "rgba(230,0,35,0.1)",
    },
    reddit: {
      mediaBackground: "linear-gradient(135deg, #fff3eb 0%, #ffffff 50%, #eef0f3 100%)",
      mediaLabel: "Reddit",
      surfaceLabel: "Post",
      accent: "#ff4500",
      avatarRing: "linear-gradient(135deg, #ff4500, #ff9a5a)",
      pillBackground: "rgba(255,69,0,0.1)",
      pillText: "#c43b00",
      tagBackground: "rgba(255,69,0,0.08)",
      tagBorder: "rgba(255,69,0,0.14)",
      tagText: "#c43b00",
      metricIconBackground: "rgba(255,69,0,0.1)",
    },
    v2ex: {
      mediaBackground: "linear-gradient(135deg, #f2f7ff 0%, #ffffff 52%, #eef2f8 100%)",
      mediaLabel: "V2EX",
      surfaceLabel: "Topic",
      accent: "#5e8fdb",
      avatarRing: "linear-gradient(135deg, #5e8fdb, #afc6e8)",
      pillBackground: "rgba(94,143,219,0.1)",
      pillText: "#365d96",
      tagBackground: "rgba(94,143,219,0.08)",
      tagBorder: "rgba(94,143,219,0.14)",
      tagText: "#365d96",
      metricIconBackground: "rgba(94,143,219,0.1)",
    },
    xiaoyuzhou: {
      mediaBackground: "linear-gradient(135deg, #e7fffc 0%, #ffffff 50%, #fff6cf 100%)",
      mediaLabel: "Xiaoyuzhou",
      surfaceLabel: "Episode",
      accent: "#00c7b7",
      avatarRing: "linear-gradient(135deg, #00c7b7, #f4d84e)",
      pillBackground: "rgba(0,199,183,0.1)",
      pillText: "#08756e",
      tagBackground: "rgba(0,199,183,0.08)",
      tagBorder: "rgba(0,199,183,0.14)",
      tagText: "#08756e",
      metricIconBackground: "rgba(0,199,183,0.1)",
      audioBackground: "linear-gradient(135deg, rgba(0,199,183,0.18), rgba(244,216,78,0.18))",
    },
    pornhub: {
      shellBackground: "#111111",
      shellBorder: "rgba(247,151,30,0.28)",
      contentBackground: "#181818",
      mediaBackground: "linear-gradient(135deg, #050505 0%, #171717 54%, #23180c 100%)",
      mediaFrameBackground: "#000",
      mediaBadgeBackground: "rgba(247,151,30,0.14)",
      mediaBorder: "rgba(247,151,30,0.2)",
      mediaText: "#ffffff",
      mediaLabel: "Pornhub",
      surfaceLabel: "Video",
      text: "#ffffff",
      muted: "#b8b8b8",
      divider: "rgba(255,255,255,0.1)",
      accent: "#f7971e",
      avatarRing: "linear-gradient(135deg, #f7971e, #ffd08a)",
      avatarFill: "#222",
      avatarText: "#fff",
      pillBackground: "rgba(247,151,30,0.14)",
      pillText: "#ffd08a",
      tagBackground: "rgba(247,151,30,0.12)",
      tagBorder: "rgba(247,151,30,0.2)",
      tagText: "#ffd08a",
      metricBackground: "rgba(255,255,255,0.06)",
      metricBorder: "rgba(255,255,255,0.08)",
      metricIconBackground: "rgba(247,151,30,0.14)",
      closeBackground: "rgba(255,255,255,0.08)",
      closeText: "#ffffff",
      closeShadow: "none",
    },
  };

  return {
    ...base,
    ...(isDark
      ? buildDarkPlatformPostChrome(platform, theme, platformChrome[platform] ?? {})
      : (platformChrome[platform] ?? {})),
  };
}

function buildDarkPlatformPostChrome(platform, theme, platformChrome) {
  const accent = theme.accent ?? "#7b8aa1";
  const accentStrong = theme.accentStrong ?? accent;
  const accentText = theme.accentText ?? "#f0f6ff";
  const chrome = {
    accent,
    avatarRing: darkPostAvatarRing(platform, accent, accentStrong),
    avatarText: accentText,
    pillBackground: hexToRgba(accent, 0.14),
    pillText: accentText,
    tagBackground: hexToRgba(accent, 0.1),
    tagBorder: hexToRgba(accent, 0.22),
    tagText: accentText,
    metricIconBackground: hexToRgba(accent, 0.14),
  };

  if (platformChrome.mediaLabel) {
    chrome.mediaLabel = platformChrome.mediaLabel;
  }

  if (platformChrome.contentLabel) {
    chrome.contentLabel = platformChrome.contentLabel;
  }

  if (platformChrome.surfaceLabel) {
    chrome.surfaceLabel = platformChrome.surfaceLabel;
  }

  return chrome;
}

function darkPostAvatarRing(platform, accent, accentStrong) {
  if (platform === "instagram") {
    return "conic-gradient(from 210deg, #feda75, #fa7e1e, #d62976, #962fbf, #4f5bd5, #feda75)";
  }

  if (platform === "tiktok" || platform === "douyin") {
    return `linear-gradient(135deg, ${accent} 0%, rgba(255,255,255,0.86) 50%, ${accentStrong} 100%)`;
  }

  return `linear-gradient(135deg, ${accent} 0%, ${accentStrong} 100%)`;
}

function getButtonTheme(platform, colorMode = "light", themeName = "default") {
  const surface = colorModeTokens[colorMode] ?? colorModeTokens.light;
  const platformTheme = buttonThemes[platform] ?? buttonThemes.neutral;
  const platformKey = buttonThemes[platform] ? platform : "neutral";
  const colorModeOverride = colorMode === "dark"
    ? darkPlatformThemeOverrides[platformKey] ?? darkPlatformThemeOverrides.neutral
    : {};

  if (themeName === "cohere") {
    return {
      ...platformTheme,
      ...surface,
      ...(cohereThemeTokens[colorMode] ?? cohereThemeTokens.light),
      uiTheme: "cohere",
      colorMode,
    };
  }

  return {
    ...platformTheme,
    ...colorModeOverride,
    ...surface,
    uiTheme: "default",
    colorMode,
  };
}

function detectPlatform(value) {
  try {
    const hostname = new URL(urlCandidateWithProtocol(value)).hostname.toLowerCase().replace(/^www\./, "");

    if (hostname === "instagram.com" || hostname.endsWith(".instagram.com") || hostname.endsWith("ddinstagram.com")) {
      return "instagram";
    }

    if (hostname === "threads.com" || hostname.endsWith(".threads.com") || hostname === "threads.net" || hostname.endsWith(".threads.net")) {
      return "threads";
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

    if (hostname === "acfun.cn" || hostname.endsWith(".acfun.cn")) {
      return "acfun";
    }

    if (hostname === "youtube.com" || hostname.endsWith(".youtube.com") || hostname === "youtu.be" || hostname.endsWith(".youtu.be") || hostname === "youtube-nocookie.com" || hostname.endsWith(".youtube-nocookie.com")) {
      return "youtube";
    }

    if (hostname === "pornhub.com" || hostname.endsWith(".pornhub.com")) {
      return "pornhub";
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

    if (hostname === "pinterest.com" || hostname.endsWith(".pinterest.com") || hostname === "pin.it") {
      return "pinterest";
    }

    if (hostname === "reddit.com" || hostname.endsWith(".reddit.com") || hostname === "redd.it" || hostname.endsWith(".redd.it")) {
      return "reddit";
    }

    if (hostname === "v2ex.com" || hostname.endsWith(".v2ex.com")) {
      return "v2ex";
    }

    if (hostname === "xiaoyuzhoufm.com" || hostname.endsWith(".xiaoyuzhoufm.com")) {
      return "xiaoyuzhou";
    }

    if (hostname === "xiaohongshu.com" || hostname.endsWith(".xiaohongshu.com") || hostname === "xhslink.com" || hostname.endsWith(".xhslink.com") || hostname === "xhslink.cn" || hostname.endsWith(".xhslink.cn") || hostname === "xhs.cn" || hostname.endsWith(".xhs.cn") || hostname === "rednote.com" || hostname.endsWith(".rednote.com")) {
      return "xiaohongshu";
    }
  } catch {
    return "";
  }

  return "";
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(urlCandidateWithProtocol(value));

    return ["http:", "https:"].includes(parsed.protocol) && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function urlCandidateWithProtocol(value) {
  const candidate = extractUrlCandidate(value);

  if (!candidate || candidate.includes("://")) {
    return candidate;
  }

  if (/^(?:www\.)?v2ex\.com(?:[/?#:]|$)/i.test(candidate)) {
    return `https://${candidate}`;
  }

  return candidate;
}

function extractUrlCandidate(value) {
  const trimmed = String(value || "").trim();
  const match = trimmed.match(shareUrlPattern) ?? trimmed.match(bareV2exUrlPattern);
  const candidate = match ? match[0] : trimmed;

  return candidate.replace(trailingUrlPunctuationPattern, "");
}

function looksLikeUrlInput(value) {
  const text = String(value || "").trim();

  if (!text) {
    return false;
  }

  return /^(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|$))/i.test(text);
}

function normalizeSearchLoginPlatforms(value) {
  const allowed = new Set(keywordSearchPlatforms.map((platform) => platform.id));
  return [...new Set(Array.isArray(value) ? value : [])]
    .filter((platform) => allowed.has(platform));
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
