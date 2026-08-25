import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { URL } from "node:url";
import vm from "node:vm";

import { AppError, ErrorCode } from "./errors";
import {
  cleanUrl,
  dedupeAssets,
  dig,
  fetchTextResponse,
  fetchWithTimeout,
  firstPresentInt,
  getProxyUrl,
  htmlUnescape,
  metaContents,
  optionalInt,
  PAGE_HEADERS,
} from "./utils";
import {
  cleanDisplayText,
  createPostInfo,
  normalizeTags,
  pickSingleLineText,
  pickText,
} from "./post-info";
import {
  balancedJsonEndIndex,
  cookieHeaderFromMap,
  createMetrics,
  mergeCookieMapFromSetCookie,
  postInfoFromHtmlMeta,
  resolveRedirect,
  safeFilenamePart,
  titleFromBody,
  withCookieHeader,
} from "./shared";

const XIAOHONGSHU_HEADERS = {
  ...PAGE_HEADERS,
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  Referer: "https://www.xiaohongshu.com/explore",
};
const XIAOHONGSHU_MOBILE_HEADERS = {
  ...XIAOHONGSHU_HEADERS,
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
const XIAOHONGSHU_RESTRICTED_HINT =
  "已尝试桌面公开页和移动 H5 公开页。如果浏览器里能打开这条笔记，请在页面点击“小红书扫码登录”，或在 .env.local 配置 SOCIAL_XIAOHONGSHU_COOKIE；如果浏览器账号也打不开，说明该笔记已被小红书限制访问或删除。";
const XIAOHONGSHU_CURL_FALLBACK_ERRORS = [
  "ERR_HTTP2_STREAM_ERROR",
  "terminated",
  "other side closed",
  "response reading failed",
  "页面响应读取失败",
];
const execFile = promisify(execFileCallback);
const XIAOHONGSHU_COMMENT_PAGE_PATHS = [
  "/api/sns/web/v2/comment/page",
];
const XIAOHONGSHU_COMMENT_SUB_PAGE_PATH = "/api/sns/web/v2/comment/sub/page";
const XIAOHONGSHU_PROFILE_POSTS_PATH = "/api/sns/web/v1/user_posted";
const XIAOHONGSHU_COMMENT_IMAGE_FORMATS = "jpg,webp,avif";
const XIAOHONGSHU_RENDERED_COMMENT_BUDGET_MS = 12_000;

let cachedXiaohongshuSigner = null;

export function normalizeXiaohongshuUrl(parsed) {
  const parts = parsed.pathname.split("/").filter(Boolean);
  const host = parsed.hostname.toLowerCase();

  if (isXiaohongshuShortHost(host) && parts.length > 0) {
    return {
      canonical_url: cleanUrl(parsed),
      shortcode: parts.join("-"),
      kind: "short",
      platform: "xiaohongshu",
    };
  }

  if (parts[0] === "user" && parts[1] === "profile" && parts[2]) {
    const canonical = new URL(`https://www.xiaohongshu.com/user/profile/${parts[2]}`);

    for (const key of ["xsec_token", "xsec_source"]) {
      const value = parsed.searchParams.get(key);

      if (value) {
        canonical.searchParams.set(key, value);
      }
    }

    return {
      canonical_url: canonical.toString(),
      creator_handle: parts[2],
      profile_id: parts[2],
      kind: "profile",
      mode: "profile",
      platform: "xiaohongshu",
    };
  }

  let noteId = "";

  if ((parts[0] === "explore" || parts[0] === "search_result") && parts[1]) {
    noteId = parts[1];
  } else if (parts.length >= 3 && parts[0] === "discovery" && parts[1] === "item") {
    noteId = parts[2];
  }

  if (/^[A-Za-z0-9_-]{8,80}$/.test(noteId)) {
    const canonical = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);

    for (const key of ["xsec_token", "xsec_source"]) {
      const value = parsed.searchParams.get(key);

      if (value) {
        canonical.searchParams.set(key, value);
      }
    }

    return {
      canonical_url: canonical.toString(),
      shortcode: noteId,
      kind: "note",
      mode: "post",
      platform: "xiaohongshu",
    };
  }

      throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持小红书主页、笔记或分享短链接。", 400);
}

/** Resolve the public snapshot embedded in an XHS creator profile page. */
export async function resolveXiaohongshuProfile(normalized, settings) {
  const pageHeaders = xiaohongshuPageHeaders(settings);
  const response = await fetchXiaohongshuPageTextWithMobileFallback({
    pageUrl: normalized.canonical_url,
    pageHeaders,
    shortcode: "",
    settings,
  });
  const state = extractXiaohongshuInitialState(response.text);
  const profileId = String(normalized.profile_id || normalized.creator_handle || "").trim();
  const profile = xiaohongshuProfileFromState(state, profileId, response.text);
  let posts = xiaohongshuProfilePostsFromState(state, profile, normalized.canonical_url);
  let pagination = { source: "xiaohongshu_public_snapshot", user_id: profile.user_id || profileId, next_cursor: "", has_more: false };

  if (profile.user_id) {
    const apiPage = await requestXiaohongshuProfilePostsPage({
      userId: profile.user_id,
      cursor: "",
      pageUrl: normalized.canonical_url,
      pageText: response.text,
      settings,
    }).catch(() => null);
    if (apiPage?.posts?.length) {
      posts = xiaohongshuProfilePostsFromState({ posts: apiPage.posts }, profile, normalized.canonical_url);
      pagination = {
        source: "xiaohongshu_profile_api",
        user_id: profile.user_id,
        next_cursor: apiPage.next_cursor,
        has_more: Boolean(apiPage.has_more && apiPage.next_cursor),
      };
    }
  }

  if (!posts.length) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有在这个小红书主页里发现可下载的帖子。", 404);
  }

  return {
    mode: "profile",
    creator_handle: profile.username || profile.user_id || profileId,
    profile,
    posts,
    profile_pagination: pagination,
  };
}

export async function resolveXiaohongshuProfilePostsPage(options = {}, settings = {}) {
  const userId = pickSingleLineText(options.userId);
  if (!userId) return { posts: [], user_id: "", next_cursor: "", has_more: false };
  const page = await requestXiaohongshuProfilePostsPage({
    userId,
    cursor: String(options.cursor || "").replace(/^live:/, ""),
    pageUrl: options.pageUrl || "https://www.xiaohongshu.com/",
    pageText: options.pageText || "",
    settings,
  });
  const profile = { username: options.creatorHandle || "", user_id: userId };
  const posts = xiaohongshuProfilePostsFromState({ posts: page.posts }, profile, options.pageUrl || "https://www.xiaohongshu.com/");
  return { posts, user_id: userId, next_cursor: page.next_cursor, has_more: page.has_more };
}

async function requestXiaohongshuProfilePostsPage({ userId, cursor, pageUrl, pageText, settings }) {
  const url = new URL(XIAOHONGSHU_PROFILE_POSTS_PATH, "https://www.xiaohongshu.com");
  url.searchParams.set("user_id", userId);
  url.searchParams.set("num", "30");
  url.searchParams.set("cursor", cursor || "");
  url.searchParams.set("image_formats", "jpg,webp,avif");
  try {
    const pageParsed = new URL(pageUrl);
    for (const key of ["xsec_token", "xsec_source"]) {
      const value = pageParsed.searchParams.get(key);
      if (value) url.searchParams.set(key, value);
    }
  } catch {}
  const headers = await xiaohongshuCommentApiHeaders({
    pageUrl,
    pageText,
    pathWithQuery: `${url.pathname}${url.search}`,
    cookieHeader: xiaohongshuCookieHeader(settings),
    settings,
  });
  const response = await fetchWithTimeout(url.toString(), { headers, cache: "no-store" }, settings.httpTimeoutMs);
  const text = await response.text();
  if (response.status >= 400) throw new AppError(ErrorCode.UPSTREAM_BLOCKED, `小红书主页接口返回异常状态码 ${response.status}。`, 502);
  let data;
  try { data = JSON.parse(text); } catch { throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "小红书主页接口没有返回 JSON。", 502); }
  const items = Array.isArray(data?.data?.notes) ? data.data.notes : Array.isArray(data?.data?.items) ? data.data.items : Array.isArray(data?.notes) ? data.notes : [];
  const nextCursor = pickSingleLineText(data?.data?.cursor, data?.data?.next_cursor, data?.cursor, data?.next_cursor);
  return { posts: items, next_cursor: nextCursor, has_more: Boolean(data?.data?.has_more ?? data?.has_more ?? nextCursor) };
}

function xiaohongshuProfileFromState(state, profileId, html) {
  const candidate = findXiaohongshuProfileUser(state, profileId) || {};
  const description = pickText(metaContents(html, ["og:description", "description"]));
  const avatar = pickSingleLineText(
    candidate.avatar,
    candidate.avatarUrl,
    candidate.avatar_url,
    candidate.image,
    candidate.images?.[0],
  );
  return {
    username: pickSingleLineText(candidate.nickname, candidate.nickName, candidate.username, candidate.userId, profileId),
    full_name: pickSingleLineText(candidate.nickname, candidate.nickName, candidate.username, profileId),
    biography: pickText(candidate.desc, candidate.description, candidate.bio, description),
    avatar_url: avatar,
    post_count: firstPresentInt(candidate.noteCount, candidate.postCount, candidate.notesCount),
    follower_count: firstPresentInt(candidate.fans, candidate.fansCount, candidate.followerCount, candidate.followers),
    following_count: firstPresentInt(candidate.follows, candidate.followingCount, candidate.following),
    is_private: Boolean(candidate.private || candidate.isPrivate),
    is_verified: Boolean(candidate.verified || candidate.isVerified),
    user_id: pickSingleLineText(candidate.userId, candidate.user_id, candidate.id, profileId),
  };
}

function findXiaohongshuProfileUser(value, profileId, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 10 || seen.has(value)) return null;
  seen.add(value);
  if (!Array.isArray(value)) {
    const id = pickSingleLineText(value.userId, value.user_id, value.uid, value.id);
    const hasName = Boolean(value.nickname || value.nickName || value.username);
    if (hasName && (!profileId || id === profileId || value.userId === profileId || value.user_id === profileId)) return value;
  }
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const found = findXiaohongshuProfileUser(child, profileId, seen, depth + 1);
    if (found) return found;
  }
  return null;
}

function xiaohongshuProfilePostsFromState(state, profile, profileUrl) {
  const posts = [];
  const seen = new Set();
  const token = (() => { try { return new URL(profileUrl).searchParams.get("xsec_token") || ""; } catch { return ""; } })();
  function visit(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 12) return;
    if (Array.isArray(value) === false && value.note && typeof value.note === "object") {
      visit(value.note, depth + 1);
    }
    if (!Array.isArray(value)) {
      const rawNote = value.note_card || value.noteCard || value.note || value;
      const noteId = pickSingleLineText(rawNote.noteId, rawNote.note_id, rawNote.id, value.noteId, value.note_id, value.id);
      const hasMedia = Array.isArray(rawNote.imageList) || rawNote.image_list || rawNote.video || rawNote.cover || rawNote.coverUrl || rawNote.cover_url;
      if (noteId && /^[A-Za-z0-9_-]{8,80}$/.test(noteId) && hasMedia && !seen.has(noteId)) {
        const note = rawNote;
        const user = note.user || note.author || {};
        const imageList = Array.isArray(note.imageList) ? note.imageList : Array.isArray(note.image_list) ? note.image_list : [];
        const media = imageList[0] || note.cover || note.image || note.cover_url || {};
        const preview = pickSingleLineText(media.url, media.originUrl, media.origin_url, media.urlPre, media.url_default, note.coverUrl, note.cover_url);
        const body = pickText(note.desc, note.description, note.content, note.display_title);
        const metrics = metricsFromXiaohongshu(note);
        const taken = firstPresentInt(note.time, note.createTime, note.createdAt, note.updateTime);
        const canonical = new URL(`https://www.xiaohongshu.com/explore/${noteId}`);
        const noteToken = pickSingleLineText(
          note.xsecToken,
          note.xsec_token,
          value.xsecToken,
          value.xsec_token,
          token,
        );
        if (noteToken) canonical.searchParams.set("xsec_token", noteToken);
        canonical.searchParams.set("xsec_source", pickSingleLineText(note.xsecSource, note.xsec_source, value.xsecSource, value.xsec_source, "pc_feed"));
        seen.add(noteId);
        posts.push({
          id: noteId,
          shortcode: noteId,
          canonical_url: canonical.toString(),
          kind: String(note.type || note.noteType || note.type_name || (note.video || note.video_url ? "video" : "image")),
          media_type: note.video || note.videoUrl ? "video" : "image",
          preview_url: preview,
          preview_width: firstPresentInt(media.width, media.width_px),
          preview_height: firstPresentInt(media.height, media.height_px),
          taken_at: taken ? new Date(taken > 1e12 ? taken : taken * 1000).toISOString() : "",
          metrics,
          post_info: createPostInfo({ title: pickSingleLineText(note.title, titleFromBody(body)), author: pickSingleLineText(user.nickname, user.nickName, profile.username), author_handle: pickSingleLineText(user.userId, profile.user_id, profile.username), body, metrics, tags: xiaohongshuTags(note) }, { metrics, creatorHandle: profile.username, source: metrics.source }),
        });
      }
    }
    for (const child of (Array.isArray(value) ? value : Object.values(value))) visit(child, depth + 1);
  }
  visit(state);
  return posts.sort((a, b) => (Date.parse(b.taken_at) || 0) - (Date.parse(a.taken_at) || 0));
}

export async function resolveXiaohongshuPost(normalized, settings) {
  let active = normalized;
  const pageHeaders = xiaohongshuPageHeaders(settings);

  if (active.kind === "short") {
    const redirected = await resolveRedirect(active.canonical_url, settings, pageHeaders);

    if (redirected) {
      active = normalizeXiaohongshuUrl(new URL(redirected));
    }
  }

  if (active.kind === "short" || !active.shortcode) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "小红书短链接没有解析到笔记 ID。", 404);
  }

  const pageUrl = active.canonical_url;
  let pageResponse = await fetchXiaohongshuPageTextWithMobileFallback({
    pageUrl,
    pageHeaders,
    shortcode: active.shortcode,
    settings,
  });
  let text = pageResponse.text;
  let initialState = extractXiaohongshuInitialState(text);
  let note = findXiaohongshuNote(initialState, active.shortcode);
  let htmlAssets = xiaohongshuHtmlAssets(text, active.shortcode, pageUrl, settings);

  if (!note && pageResponse.source !== "xiaohongshu_mobile_h5" && htmlAssets.length === 0) {
    const mobileResponse = await fetchXiaohongshuMobileSupplement({
      pageUrl,
      shortcode: active.shortcode,
      settings,
    });

    if (mobileResponse) {
      pageResponse = mobileResponse;
      text = pageResponse.text;
      initialState = extractXiaohongshuInitialState(text);
      note = findXiaohongshuNote(initialState, active.shortcode);
      htmlAssets = xiaohongshuHtmlAssets(text, active.shortcode, pageUrl, settings);
    }
  }

  if (!note) {
    if (looksLikeXiaohongshuVerification(text) && htmlAssets.length === 0) {
      throw xiaohongshuRestrictedError({ reason: "verification_page" });
    }

    const fallbackAssets = [
      ...htmlAssets,
      ...xiaohongshuMetaAssets(text, active.shortcode, pageUrl, settings),
    ];

    if (fallbackAssets.length > 0) {
      const metrics = createMetrics("xiaohongshu_public_best_effort");

      return {
        assets: dedupeAssets(fallbackAssets),
        metrics,
        creator_handle: "",
        post_info: postInfoFromHtmlMeta(text, metrics, ""),
      };
    }

    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "小红书页面中没有发现可展示资源。", 404);
  }

  const user = note.user && typeof note.user === "object" ? note.user : {};
  const handle = user.nickname || user.nickName || user.userId || "unknown";
  const filenameBase = `xiaohongshu_${safeFilenamePart(handle)}_${active.shortcode}`;
  const mediaHeaders = xiaohongshuMediaHeaders(pageUrl, settings);
  let assets = xiaohongshuAssetsFromNote(note, filenameBase, mediaHeaders);
  let bestHtmlAssets = htmlAssets;

  if (pageResponse.source !== "xiaohongshu_mobile_h5") {
    const mobileResponse = await fetchXiaohongshuMobileSupplement({
      pageUrl,
      shortcode: active.shortcode,
      settings,
    });
    const mobileHtmlAssets = mobileResponse
      ? xiaohongshuHtmlAssets(mobileResponse.text, active.shortcode, pageUrl, settings)
      : [];

    if (mobileHtmlAssets.length > 0) {
      bestHtmlAssets = dedupeAssets([...mobileHtmlAssets, ...htmlAssets]);
    }
  }

  assets = mergeXiaohongshuNoteAndHtmlAssets({
    noteAssets: assets,
    htmlAssets: bestHtmlAssets,
    preferHtmlImages: pageResponse.source === "xiaohongshu_mobile_h5",
  });

  if (assets.length === 0) {
    assets.push(...bestHtmlAssets);
  }

  if (assets.length === 0) {
    assets.push(...xiaohongshuMetaAssets(text, active.shortcode, pageUrl, settings));
  }

  if (assets.length === 0) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "小红书页面中没有发现可展示资源。", 404);
  }

  const metrics = metricsFromXiaohongshu(note);

  return {
    assets: dedupeAssets(assets),
    metrics,
    creator_handle: handle,
    post_info: postInfoFromXiaohongshu(note, metrics, handle),
  };
}

export async function resolveXiaohongshuComments(normalized, options = {}, settings = {}) {
  const active = await resolveXiaohongshuActiveNote(normalized, settings);
  const pageUrl = active.canonical_url;
  const pageHeaders = xiaohongshuPageHeaders(settings);
  const pageResponse = await fetchXiaohongshuPageTextWithMobileFallback({
    pageUrl,
    pageHeaders,
    shortcode: active.shortcode,
    settings,
  });
  const text = pageResponse.text;
  const initialState = extractXiaohongshuInitialState(text);
  const note = findXiaohongshuNote(initialState, active.shortcode);
  const limit = normalizeXiaohongshuCommentLimit(options.limit);
  const cursor = parseXiaohongshuCommentCursor(options.cursor);
  const xsecToken = xiaohongshuNoteXsecToken(note, pageUrl);
  const cookieHeader = xiaohongshuCommentCookieHeader(settings, pageResponse.headers);

  if (cursor.type !== "snapshot") {
    const apiPayload = await requestXiaohongshuCommentPage({
      pageUrl,
      pageText: text,
      noteId: active.shortcode,
      cursor: cursor.type === "api" ? cursor.value : "",
      topCommentId: "",
      xsecToken,
      limit,
      cookieHeader,
      settings,
    }).catch(() => null);

    if (apiPayload && (apiPayload.comments.length > 0 || apiPayload.nextCursor || apiPayload.totalCount != null)) {
      return {
        platform: "xiaohongshu",
        shortcode: active.shortcode,
        canonical_url: pageUrl,
        comments: apiPayload.comments,
        next_cursor: apiPayload.nextCursor ? `api:${apiPayload.nextCursor}` : null,
        has_more: Boolean(apiPayload.nextCursor),
        total_count: apiPayload.totalCount,
        public_count: apiPayload.publicCount,
        is_partial_public_snapshot: apiPayload.totalCount != null && apiPayload.publicCount < apiPayload.totalCount,
        source: apiPayload.source,
      };
    }
  }

  const renderedSnapshot = await xiaohongshuRenderedCommentSnapshot({
    pageUrl,
    shortcode: active.shortcode,
    settings,
  }).catch(() => null);

  if (renderedSnapshot?.comments?.length > 0) {
    const offset = cursor.type === "snapshot" ? cursor.offset : 0;
    const endOffset = offset + limit;
    const comments = renderedSnapshot.comments.slice(offset, endOffset);
    const totalCount = renderedSnapshot.totalCount ?? parseXiaohongshuCount(note?.interactInfo?.commentCount) ?? renderedSnapshot.comments.length;
    const nextCursor = endOffset < renderedSnapshot.comments.length ? `snapshot:${endOffset}` : null;

    return {
      platform: "xiaohongshu",
      shortcode: active.shortcode,
      canonical_url: pageUrl,
      comments,
      next_cursor: nextCursor,
      has_more: Boolean(nextCursor),
      total_count: totalCount,
      public_count: renderedSnapshot.comments.length,
      is_partial_public_snapshot: totalCount > renderedSnapshot.comments.length,
      source: renderedSnapshot.source,
    };
  }

  const publicComments = xiaohongshuPageComments(initialState, active.shortcode);
  const offset = cursor.type === "snapshot" ? cursor.offset : 0;
  const endOffset = offset + limit;
  const comments = publicComments
    .slice(offset, endOffset)
    .map((comment) => normalizeXiaohongshuComment(comment))
    .filter((comment) => comment.id);
  const totalCount = parseXiaohongshuCount(note?.interactInfo?.commentCount) ?? publicComments.length;
  const nextCursor = endOffset < publicComments.length ? `snapshot:${endOffset}` : null;

  return {
    platform: "xiaohongshu",
    shortcode: active.shortcode,
    canonical_url: pageUrl,
    comments,
    next_cursor: nextCursor,
    has_more: Boolean(nextCursor),
    total_count: totalCount,
    public_count: publicComments.length,
    is_partial_public_snapshot: totalCount > publicComments.length,
    source: "xiaohongshu_public_comment_snapshot",
  };
}

async function resolveXiaohongshuActiveNote(normalized, settings = {}) {
  let active = normalized;
  const pageHeaders = xiaohongshuPageHeaders(settings);

  if (active.kind === "short") {
    const redirected = await resolveRedirect(active.canonical_url, settings, pageHeaders);

    if (redirected) {
      active = normalizeXiaohongshuUrl(new URL(redirected));
    }
  }

  if (active.kind === "short" || !active.shortcode) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "小红书短链接没有解析到笔记 ID。", 404);
  }

  return active;
}

async function fetchXiaohongshuPageText(options) {
  const allowRestrictedText = Boolean(options.allowRestrictedText);

  if (options.forceCurl) {
    const text = await fetchXiaohongshuPageTextWithCurl(options);

    if (!allowRestrictedText && looksLikeXiaohongshuVerification(text)) {
      throw xiaohongshuRestrictedError({ reason: "curl_verification_page" });
    }

    return {
      headers: new Headers(),
      response: null,
      text,
    };
  }

  try {
    return await fetchTextResponse(options);
  } catch (error) {
    if (isXiaohongshuRestrictedError(error)) {
      throw xiaohongshuRestrictedError({
        reason: "restricted_redirect",
        upstream: error.details,
      });
    }

    if (!shouldUseXiaohongshuCurlFallback(error)) {
      throw error;
    }

    const text = await fetchXiaohongshuPageTextWithCurl(options);

    if (!allowRestrictedText && looksLikeXiaohongshuVerification(text)) {
      throw xiaohongshuRestrictedError({ reason: "curl_verification_page" });
    }

    return {
      headers: new Headers(),
      response: null,
      text,
    };
  }
}

async function fetchXiaohongshuPageTextWithMobileFallback({
  pageUrl,
  pageHeaders,
  shortcode,
  settings,
}) {
  try {
    const response = await fetchXiaohongshuPageText({
      url: pageUrl,
      headers: pageHeaders,
      label: "Xiaohongshu",
      timeoutMs: settings.httpTimeoutMs,
    });

    if (
      looksLikeXiaohongshuVerification(response.text) &&
      xiaohongshuHtmlAssets(response.text, shortcode, pageUrl, settings).length === 0
    ) {
      return await fetchXiaohongshuMobilePageText({
        pageUrl,
        shortcode,
        settings,
        upstream: { reason: "desktop_restricted_text" },
      });
    }

    return response;
  } catch (error) {
    if (!isXiaohongshuDesktopFallbackError(error)) {
      throw error;
    }

    return await fetchXiaohongshuMobilePageText({
      pageUrl,
      shortcode,
      settings,
      upstream: error.details,
    });
  }
}

async function fetchXiaohongshuMobilePageText({
  pageUrl,
  shortcode,
  settings,
  upstream,
}) {
  const mobileHeaders = xiaohongshuMobilePageHeaders(settings);
  const mobileUrl = xiaohongshuMobileUrl(pageUrl, shortcode);
  const mobileResponse = await fetchXiaohongshuPageText({
    url: mobileUrl,
    headers: mobileHeaders,
    label: "Xiaohongshu mobile",
    timeoutMs: settings.httpTimeoutMs,
    allowRestrictedText: true,
    forceCurl: true,
  });
  const mobileAssets = xiaohongshuHtmlAssets(mobileResponse.text, shortcode, pageUrl, settings);

  if (mobileAssets.length === 0 && looksLikeXiaohongshuVerification(mobileResponse.text)) {
    throw xiaohongshuRestrictedError({
      reason: "mobile_h5_restricted",
      upstream,
    });
  }

  return {
    ...mobileResponse,
    source: "xiaohongshu_mobile_h5",
  };
}

async function fetchXiaohongshuMobileSupplement({
  pageUrl,
  shortcode,
  settings,
}) {
  try {
    return await fetchXiaohongshuMobilePageText({
      pageUrl,
      shortcode,
      settings,
      upstream: { reason: "mobile_h5_supplement" },
    });
  } catch (error) {
    if (error instanceof AppError) {
      return null;
    }

    throw error;
  }
}

function shouldUseXiaohongshuCurlFallback(error) {
  const details = [
    error?.message,
    error?.details,
    error?.cause?.message,
    error?.cause?.code,
  ]
    .filter(Boolean)
    .map((value) => typeof value === "string" ? value : JSON.stringify(value))
    .join(" ");

  return XIAOHONGSHU_CURL_FALLBACK_ERRORS.some((pattern) =>
    details.toLowerCase().includes(pattern.toLowerCase()),
  );
}

async function fetchXiaohongshuPageTextWithCurl({ url, headers, label, timeoutMs }) {
  const timeoutSeconds = Math.max(1, Math.ceil((timeoutMs || 20_000) / 1000));
  const args = [
    "-sS",
    "-L",
    "--compressed",
    "--max-time",
    String(timeoutSeconds),
    "-A",
    headers["user-agent"],
    "-H",
    `accept: ${headers.accept}`,
    "-H",
    `accept-language: ${headers["accept-language"]}`,
    "-H",
    `referer: ${headers.Referer}`,
  ];
  const cookieHeader = headers.cookie || headers.Cookie;

  if (cookieHeader) {
    args.push("-H", `cookie: ${cookieHeader}`);
  }

  const proxyUrl = getProxyUrl();

  if (proxyUrl) {
    args.push("--proxy", proxyUrl);
  }

  args.push("--http1.1", url);

  try {
    const { stdout } = await execFile("curl", args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: (timeoutSeconds + 2) * 1000,
    });

    return stdout;
  } catch (error) {
    if (error?.signal === "SIGTERM" || error?.killed) {
      throw new AppError(ErrorCode.UPSTREAM_BLOCKED, `${label} 页面请求超时。`, 504);
    }

    throw new AppError(
      ErrorCode.UPSTREAM_BLOCKED,
      `无法访问 ${label} 页面（curl fallback 失败）。`,
      502,
      error?.message,
    );
  }
}

function xiaohongshuPageHeaders(settings = {}) {
  return withCookieHeader(XIAOHONGSHU_HEADERS, xiaohongshuCookieHeader(settings));
}

function xiaohongshuMobilePageHeaders(settings = {}) {
  return withCookieHeader(XIAOHONGSHU_MOBILE_HEADERS, xiaohongshuCookieHeader(settings));
}

function xiaohongshuMobileUrl(pageUrl, shortcode) {
  const parsed = new URL(pageUrl);

  if (shortcode) {
    parsed.pathname = `/explore/${shortcode}`;
  }

  return parsed.toString();
}

function xiaohongshuCookieHeader(settings = {}) {
  const raw = String(
    settings.xiaohongshuCookie ||
      process.env.SOCIAL_XIAOHONGSHU_COOKIE ||
      process.env.SOCIAL_XHS_COOKIE ||
      process.env.XIAOHONGSHU_COOKIE ||
      process.env.XHS_COOKIE ||
      "",
  )
    .trim()
    .replace(/^cookie\s*:\s*/i, "")
    .replace(/^["']|["']$/g, "");

  return raw.includes("=") ? raw.replace(/[\r\n]+/g, " ").trim() : "";
}

function xiaohongshuCommentCookieHeader(settings = {}, pageHeaders = new Headers()) {
  const cookieMap = new Map();

  mergeCookieMapFromHeader(cookieMap, xiaohongshuCookieHeader(settings));
  mergeCookieMapFromSetCookie(cookieMap, pageHeaders);

  return cookieHeaderFromMap(cookieMap);
}

function mergeCookieMapFromHeader(cookieMap, cookieHeader) {
  for (const part of String(cookieHeader || "").split(";")) {
    const pair = part.trim();
    const name = pair.split("=", 1)[0]?.trim();

    if (name && pair.includes("=")) {
      cookieMap.set(name, pair);
    }
  }
}

function isXiaohongshuRestrictedError(error) {
  if (
    error instanceof AppError &&
    error.code === ErrorCode.UPSTREAM_BLOCKED &&
    (error.details?.hint === XIAOHONGSHU_RESTRICTED_HINT || /小红书限制/.test(error.message))
  ) {
    return true;
  }

  const details = error?.details;
  const text = [
    error?.message,
    typeof details === "string" ? details : "",
    details?.final_url,
    details?.location,
    details?.body_excerpt,
  ]
    .filter(Boolean)
    .join(" ");

  return looksLikeXiaohongshuRestrictedText(text);
}

function isXiaohongshuDesktopFallbackError(error) {
  return isXiaohongshuRestrictedError(error) ||
    (
      error instanceof AppError &&
      error.code === ErrorCode.NO_MEDIA_FOUND
    );
}

function xiaohongshuRestrictedError(details = {}) {
  return new AppError(
    ErrorCode.UPSTREAM_BLOCKED,
    "小红书限制了这条笔记的公开访问或触发了安全验证，暂时无法用匿名公开页面解析资源。",
    502,
    {
      ...details,
      hint: XIAOHONGSHU_RESTRICTED_HINT,
    },
  );
}

function extractXiaohongshuInitialState(text) {
  const scripts = xiaohongshuScriptTexts(text);
  const candidates = scripts.length > 0 ? scripts.reverse() : [String(text || "")];

  for (const scriptText of candidates) {
    const state = extractXiaohongshuInitialStateFromScript(scriptText);

    if (state) {
      return state;
    }
  }

  return null;
}

function xiaohongshuScriptTexts(text) {
  return Array.from(String(text || "").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
    .map((match) => htmlUnescape(match[1]).trim())
    .filter((script) => /^window\.__INITIAL_STATE__\s*=/i.test(script));
}

function extractXiaohongshuInitialStateFromScript(text) {
  const assignment = /window\.__INITIAL_STATE__\s*=/i.exec(text);

  if (!assignment) {
    return null;
  }

  const afterAssignment = text.slice(assignment.index + assignment[0].length);
  const encodedMatch = /JSON\.parse\(\s*decodeURIComponent\(\s*["']([^"']+)["']\s*\)\s*\)/i.exec(afterAssignment);

  if (encodedMatch) {
    return parseXiaohongshuStateJson(decodeURIComponentSafe(encodedMatch[1]));
  }

  const startIndex = afterAssignment.indexOf("{");

  if (startIndex < 0) {
    return null;
  }

  const endIndex = balancedJsonEndIndex(afterAssignment, startIndex);

  if (endIndex < 0) {
    return null;
  }

  return parseXiaohongshuStateJson(afterAssignment.slice(startIndex, endIndex));
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseXiaohongshuStateJson(rawJson) {
  const decoded = htmlUnescape(String(rawJson || ""));
  const attempts = [
    decoded,
    decoded.replace(/\bundefined\b/g, "null"),
    decoded
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/\bundefined\b/g, "null"),
  ];

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // Try the next normalization.
    }
  }

  return null;
}

function findXiaohongshuNote(initialState, noteId) {
  if (!initialState || typeof initialState !== "object") {
    return null;
  }

  const detailMap = dig(initialState, "note", "noteDetailMap");
  const currentNoteId = dig(initialState, "note", "currentNoteId");
  const mobileNote = dig(initialState, "noteData", "data", "noteData");

  if (
    isXiaohongshuNoteCandidate(mobileNote) &&
    (!noteId || mobileNote.noteId === noteId || mobileNote.id === noteId)
  ) {
    return mobileNote;
  }

  for (const key of [noteId, currentNoteId]) {
    const note = noteFromXiaohongshuMap(detailMap, key);

    if (note) {
      return note;
    }
  }

  if (detailMap && typeof detailMap === "object") {
    for (const value of Object.values(detailMap)) {
      const note = value?.note && typeof value.note === "object" ? value.note : value;

      if (isXiaohongshuNoteCandidate(note)) {
        return note;
      }
    }
  }

  return findXiaohongshuNoteRecursive(initialState, noteId);
}

function noteFromXiaohongshuMap(detailMap, noteId) {
  if (!detailMap || typeof detailMap !== "object" || !noteId) {
    return null;
  }

  const entry = detailMap[noteId];
  const note = entry?.note && typeof entry.note === "object" ? entry.note : entry;

  return isXiaohongshuNoteCandidate(note) ? note : null;
}

function findXiaohongshuNoteRecursive(value, noteId, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) {
    return null;
  }

  seen.add(value);

  if (isXiaohongshuNoteCandidate(value) && (!noteId || value.noteId === noteId || value.id === noteId)) {
    return value;
  }

  if (value.note && isXiaohongshuNoteCandidate(value.note)) {
    const note = value.note;

    if (!noteId || note.noteId === noteId || note.id === noteId) {
      return note;
    }
  }

  let fallback = isXiaohongshuNoteCandidate(value) ? value : null;
  const children = Array.isArray(value) ? value : Object.values(value);

  for (const child of children) {
    const found = findXiaohongshuNoteRecursive(child, noteId, seen, depth + 1);

    if (found && (found.noteId === noteId || found.id === noteId)) {
      return found;
    }

    fallback ||= found;
  }

  return fallback;
}

function isXiaohongshuNoteCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Boolean(
    (value.noteId || value.id) &&
    (Array.isArray(value.imageList) || value.video || value.interactInfo || value.user),
  );
}

function normalizeXiaohongshuCommentLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return 12;
  }

  return Math.max(1, Math.min(30, parsed));
}

function parseXiaohongshuCommentCursor(value) {
  const raw = String(value ?? "").trim();

  if (!raw) {
    return { type: "api", value: "", offset: 0 };
  }

  if (raw.startsWith("api:")) {
    return { type: "api", value: raw.slice("api:".length), offset: 0 };
  }

  if (raw.startsWith("snapshot:")) {
    return { type: "snapshot", value: "", offset: normalizeXiaohongshuCommentOffset(raw.slice("snapshot:".length)) };
  }

  const offset = normalizeXiaohongshuCommentOffset(raw);

  if (String(offset) === raw) {
    return { type: "snapshot", value: "", offset };
  }

  return { type: "api", value: raw, offset: 0 };
}

function normalizeXiaohongshuCommentOffset(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

function xiaohongshuNoteXsecToken(note, pageUrl) {
  const fromNote = pickSingleLineText(note?.xsecToken, note?.xsec_token);

  if (fromNote) {
    return fromNote;
  }

  try {
    return new URL(pageUrl).searchParams.get("xsec_token") || "";
  } catch {
    return "";
  }
}

function xiaohongshuPageComments(initialState, noteId) {
  const comments = [];
  const detailMap = dig(initialState, "note", "noteDetailMap");
  const noteEntries = [];

  if (detailMap && typeof detailMap === "object") {
    for (const key of [noteId, dig(initialState, "note", "currentNoteId")]) {
      if (key && detailMap[key]) {
        noteEntries.push(detailMap[key]);
      }
    }

    noteEntries.push(...Object.values(detailMap));
  }

  for (const entry of noteEntries) {
    const list = entry?.comments?.list ?? entry?.commentList ?? entry?.comments;

    if (Array.isArray(list)) {
      comments.push(...list.filter((comment) => looksLikeXiaohongshuComment(comment, noteId)));
    }
  }

  return dedupeXiaohongshuCommentNodes(comments);
}

async function requestXiaohongshuCommentPage({
  pageUrl,
  pageText,
  noteId,
  cursor,
  topCommentId,
  xsecToken,
  limit,
  cookieHeader,
  settings,
}) {
  for (const path of XIAOHONGSHU_COMMENT_PAGE_PATHS) {
    const data = await requestXiaohongshuCommentApi({
      path,
      pageUrl,
      pageText,
      params: {
        note_id: noteId,
        cursor: cursor || "",
        num: String(limit),
        top_comment_id: topCommentId || "",
        image_formats: XIAOHONGSHU_COMMENT_IMAGE_FORMATS,
        xsec_token: xsecToken || "",
      },
      cookieHeader,
      settings,
    }).catch(() => null);
    const page = parseXiaohongshuCommentApiPayload(data, "xiaohongshu_web_comment_page");

    if (!page) {
      continue;
    }

    const comments = [];

    for (const comment of page.rawComments.slice(0, limit)) {
      const expanded = await expandXiaohongshuCommentReplies({
        comment,
        pageUrl,
        pageText,
        noteId,
        topCommentId,
        xsecToken,
        cookieHeader,
        settings,
      });

      comments.push(normalizeXiaohongshuComment(expanded));
    }

    return {
      ...page,
      comments: comments.filter((comment) => comment.id),
      publicCount: page.publicCount ?? comments.length,
    };
  }

  return null;
}

async function expandXiaohongshuCommentReplies({
  comment,
  pageUrl,
  pageText,
  noteId,
  topCommentId,
  xsecToken,
  cookieHeader,
  settings,
}) {
  const replyCount = parseXiaohongshuCount(comment?.subCommentCount ?? comment?.sub_comment_count ?? comment?.replyCount);
  const replies = xiaohongshuCommentReplies(comment);

  if (!comment?.id || !replyCount || replies.length >= replyCount) {
    return comment;
  }

  let cursor = pickSingleLineText(comment.subCommentCursor, comment.sub_comment_cursor);
  let hasMore = true;
  const expanded = [...replies];

  while (hasMore && expanded.length < Math.min(replyCount, 30)) {
    const data = await requestXiaohongshuCommentApi({
      path: XIAOHONGSHU_COMMENT_SUB_PAGE_PATH,
      pageUrl,
      pageText,
      params: {
        note_id: noteId,
        root_comment_id: comment.id,
        num: "10",
        cursor,
        image_formats: XIAOHONGSHU_COMMENT_IMAGE_FORMATS,
        top_comment_id: topCommentId || "",
        xsec_token: xsecToken || "",
      },
      cookieHeader,
      settings,
    }).catch(() => null);
    const page = parseXiaohongshuCommentApiPayload(data, "xiaohongshu_web_comment_sub_page");

    if (!page || page.rawComments.length === 0) {
      break;
    }

    expanded.push(...page.rawComments);
    cursor = page.nextCursor || "";
    hasMore = Boolean(page.nextCursor);
  }

  return {
    ...comment,
    subComments: dedupeXiaohongshuCommentNodes(expanded),
  };
}

async function requestXiaohongshuCommentApi({
  path,
  pageUrl,
  pageText,
  params,
  cookieHeader,
  settings = {},
}) {
  const url = new URL(path, "https://www.xiaohongshu.com");

  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, String(value ?? ""));
  }

  const pathWithQuery = `${url.pathname}${url.search}`;
  const headers = await xiaohongshuCommentApiHeaders({
    pageUrl,
    pageText,
    pathWithQuery,
    cookieHeader,
    settings,
  });
  const response = await fetchWithTimeout(url.toString(), {
    headers,
    cache: "no-store",
  }, Math.min(settings.httpTimeoutMs ?? 20_000, 8_000));
  const text = await response.text();

  if (response.status >= 400) {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, `小红书评论接口返回异常状态码 ${response.status}。`, 502, {
      body_excerpt: text.slice(0, 240),
    });
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "小红书评论接口没有返回 JSON。", 502, {
      body_excerpt: text.slice(0, 240),
    });
  }
}

async function xiaohongshuCommentApiHeaders({
  pageUrl,
  pageText,
  pathWithQuery,
  cookieHeader,
  settings,
}) {
  const signHeaders = await xiaohongshuSignedHeaders(pathWithQuery, pageText, settings).catch(() => ({}));

  return withCookieHeader({
    ...PAGE_HEADERS,
    accept: "application/json, text/plain, */*",
    "accept-language": XIAOHONGSHU_HEADERS["accept-language"],
    Origin: "https://www.xiaohongshu.com",
    Referer: pageUrl,
    "x-b3-traceid": randomXiaohongshuTraceId(pathWithQuery),
    ...signHeaders,
  }, cookieHeader || xiaohongshuCookieHeader(settings));
}

async function xiaohongshuSignedHeaders(pathWithQuery, pageText, settings = {}) {
  const signer = await loadXiaohongshuSigner(pageText, settings);
  const commonHeaders = {
    "X-Mns": "unload",
    "X-S-Common": xiaohongshuXSCommonHeader(),
  };

  if (!signer) {
    return commonHeaders;
  }

  const signed = signer(pathWithQuery, "");

  if (!signed) {
    return commonHeaders;
  }

  return {
    ...commonHeaders,
    "x-s": typeof signed === "string" && /^XYS_|^XYW_/.test(signed)
      ? signed
      : `XYW_${Buffer.from(signed).toString("base64")}`,
    "x-t": String(Date.now()),
  };
}

function xiaohongshuXSCommonHeader() {
  const payload = {
    s0: 5,
    s1: "",
    x0: "b1b1",
    x1: "4.3.7",
    x2: "PC",
    x3: "xhs-pc-web",
    x4: "6.27.1",
    x5: "",
    x6: "",
    x7: "",
    x8: "",
    x9: xiaohongshuCrc32(""),
    x10: 0,
    x11: "normal",
    x12: "0;",
  };

  return xiaohongshuCustomBase64(xiaohongshuUtf8Bytes(JSON.stringify(payload)));
}

function xiaohongshuUtf8Bytes(value) {
  return Array.from(Buffer.from(String(value || ""), "utf8"));
}

function xiaohongshuCustomBase64(bytes) {
  const alphabet = "ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5";
  const input = Array.isArray(bytes) ? bytes : [];
  const remainder = input.length % 3;
  const output = [];
  const end = input.length - remainder;

  for (let index = 0; index < end; index += 3) {
    const triplet = ((input[index] << 16) & 0xff0000) +
      ((input[index + 1] << 8) & 0xff00) +
      (input[index + 2] & 0xff);

    output.push(
      alphabet[(triplet >> 18) & 63],
      alphabet[(triplet >> 12) & 63],
      alphabet[(triplet >> 6) & 63],
      alphabet[triplet & 63],
    );
  }

  if (remainder === 1) {
    const value = input[input.length - 1];
    output.push(alphabet[value >> 2], alphabet[(value << 4) & 63], "=", "=");
  } else if (remainder === 2) {
    const value = (input[input.length - 2] << 8) + input[input.length - 1];
    output.push(alphabet[value >> 10], alphabet[(value >> 4) & 63], alphabet[(value << 2) & 63], "=");
  }

  return output.join("");
}

function xiaohongshuCrc32(value) {
  let crc = -1;

  for (const character of String(value || "")) {
    crc ^= character.charCodeAt(0);

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }

  return ((-1 ^ crc) ^ 0xedb88320) | 0;
}

async function loadXiaohongshuSigner(pageText, settings = {}) {
  if (cachedXiaohongshuSigner) {
    return cachedXiaohongshuSigner;
  }

  const signUrl = xiaohongshuSignScriptUrl(pageText);

  if (!signUrl) {
    return null;
  }

  const response = await fetchXiaohongshuPageText({
    url: signUrl,
    headers: XIAOHONGSHU_HEADERS,
    label: "Xiaohongshu sign",
    timeoutMs: settings.httpTimeoutMs ?? 20_000,
    allowRestrictedText: true,
  });
  const context = {
    console,
    parseInt,
    Uint8Array,
    Date,
    Math,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    Promise,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    decodeURIComponent,
  };
  context.globalThis = context;

  vm.runInNewContext(response.text, context, { timeout: 3_000 });

  if (typeof context._dsf !== "function") {
    return null;
  }

  cachedXiaohongshuSigner = (pathWithQuery, body = "") => context._dsf(pathWithQuery, body);

  return cachedXiaohongshuSigner;
}

function xiaohongshuSignScriptUrl(pageText) {
  const fromState = /"signConfig"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/i.exec(String(pageText || ""));

  if (fromState?.[1]) {
    return decodeJsonUrl(fromState[1]);
  }

  const fromHtml = /https?:\\?\/\\?\/[^"'<>\\\s]+\/as\/v2\/ds\/[^"'<>\\\s]+\.js/i.exec(String(pageText || ""));

  return fromHtml ? decodeJsonUrl(fromHtml[0]) : "";
}

function decodeJsonUrl(value) {
  return htmlUnescape(String(value || "").replace(/\\\//g, "/"));
}

async function xiaohongshuRenderedCommentSnapshot({
  pageUrl,
  shortcode,
  settings = {},
}) {
  const html = await fetchRenderedXiaohongshuHtml(pageUrl, settings);

  if (!html) {
    return null;
  }

  const comments = parseRenderedXiaohongshuComments(html)
    .map((comment) => normalizeXiaohongshuComment(comment))
    .filter((comment) => comment.id && comment.text);

  if (comments.length === 0) {
    return null;
  }

  return {
    comments,
    totalCount: renderedXiaohongshuCommentTotal(html, shortcode),
    source: "xiaohongshu_rendered_public_comment_snapshot",
  };
}

async function fetchRenderedXiaohongshuHtml(pageUrl, settings = {}) {
  if (!isEnabledValue(process.env.SOCIAL_RENDERED_XIAOHONGSHU_COMMENTS) &&
      !isEnabledValue(process.env.SOCIAL_RENDERED_XHS_COMMENTS)) {
    return "";
  }

  const chromePath = resolveChromePath();

  if (!chromePath) {
    return "";
  }

  const profileDir = mkdtempSync(`${tmpdir()}/linkmigo-xhs-comments-`);
  const timeoutMs = Math.min(Math.max((settings.httpTimeoutMs ?? 20_000) * 2, 25_000), 60_000);

  try {
    const { stdout } = await execFile(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
        "--disable-features=AutofillServerCommunication,MediaRouter,OptimizationGuideModelDownloading",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profileDir}`,
        "--dump-dom",
        `--virtual-time-budget=${XIAOHONGSHU_RENDERED_COMMENT_BUDGET_MS}`,
        pageUrl,
      ],
      {
        encoding: "utf8",
        maxBuffer: 40 * 1024 * 1024,
        timeout: timeoutMs,
      },
    );

    return stdout;
  } catch {
    return "";
  } finally {
    try {
      rmSync(profileDir, { force: true, recursive: true });
    } catch {
      // Temporary browser profiles are best-effort cleanup.
    }
  }
}

function parseRenderedXiaohongshuComments(html) {
  const region = renderedXiaohongshuCommentsRegion(html);
  const comments = [];

  for (const chunk of renderedXiaohongshuParentCommentChunks(region)) {
    const replyIndex = searchRenderedClassIndex(chunk, "reply-container");
    const commentChunk = replyIndex >= 0 ? chunk.slice(0, replyIndex) : chunk;
    const comment = renderedXiaohongshuCommentFromChunk(commentChunk);

    if (!comment) {
      continue;
    }

    const replyRegion = replyIndex >= 0 ? chunk.slice(replyIndex) : "";
    const replies = renderedXiaohongshuSubCommentChunks(replyRegion)
      .map((replyChunk) => renderedXiaohongshuCommentFromChunk(replyChunk))
      .filter(Boolean);

    comment.subComments = replies;
    comment.subCommentCount = Math.max(comment.subCommentCount ?? 0, replies.length);
    comments.push(comment);
  }

  return dedupeXiaohongshuCommentNodes(comments);
}

function renderedXiaohongshuCommentsRegion(html) {
  const text = String(html || "");
  const commentsIndex = searchRenderedClassIndex(text, "comments-el");

  if (commentsIndex < 0) {
    return text;
  }

  const tail = text.slice(commentsIndex);
  const endMatches = [
    searchRenderedClassIndex(tail, "bottom-page"),
    tail.indexOf("</body>"),
  ].filter((index) => index > 0);
  const endIndex = endMatches.length > 0 ? Math.min(...endMatches) : tail.length;

  return tail.slice(0, endIndex);
}

function renderedXiaohongshuParentCommentChunks(region) {
  return renderedChunksByClass(region, "parent-comment");
}

function renderedXiaohongshuSubCommentChunks(region) {
  return renderedChunksByClass(region, "comment-item-sub");
}

function renderedChunksByClass(html, className) {
  const text = String(html || "");
  const pattern = new RegExp(`<div\\b[^>]*class=["'][^"']*\\b${escapeRegExpLiteral(className)}\\b[^"']*["'][^>]*>`, "gi");
  const starts = [];
  let match;

  while ((match = pattern.exec(text))) {
    starts.push(match.index);
  }

  return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length));
}

function renderedXiaohongshuCommentFromChunk(chunk) {
  const id = renderedXiaohongshuCommentId(chunk);
  const authorTag = /<a\b[^>]*class=["'][^"']*\bname\b[^"']*["'][^>]*>[\s\S]*?<\/a>/i.exec(chunk)?.[0] || "";
  const authorName = stripRenderedHtml(authorTag);
  const text = renderedXiaohongshuCommentText(chunk);

  if (!id || !authorName || !text) {
    return null;
  }

  const date = renderedXiaohongshuCommentDate(chunk);
  const avatarTag = /<img\b[^>]*class=["'][^"']*\bavatar-item\b[^"']*["'][^>]*>/i.exec(chunk)?.[0] || "";

  return {
    id,
    content: text,
    createTime: date.createdAt,
    ipLocation: date.location,
    likeCount: renderedXiaohongshuLikeCount(chunk),
    subCommentCount: renderedXiaohongshuReplyCount(chunk),
    userInfo: {
      nickname: authorName,
      userId: renderedHtmlAttribute(authorTag, "data-user-id"),
      avatarUrl: renderedHtmlAttribute(avatarTag, "src"),
    },
  };
}

function renderedXiaohongshuCommentId(chunk) {
  const fromId = /\bid=["']comment-([^"']+)["']/i.exec(chunk)?.[1];

  if (fromId) {
    return fromId;
  }

  const author = stripRenderedHtml(/<a\b[^>]*class=["'][^"']*\bname\b[^"']*["'][^>]*>[\s\S]*?<\/a>/i.exec(chunk)?.[0] || "");
  const text = renderedXiaohongshuCommentText(chunk);
  const date = renderedXiaohongshuCommentDate(chunk).createdAt;

  return `rendered-${hashXiaohongshuComment(`${author}|${text}|${date}`)}`;
}

function renderedXiaohongshuCommentText(chunk) {
  const match = /<span\b[^>]*class=["'][^"']*\bnote-text\b[^"']*["'][^>]*>([\s\S]*)<\/span>\s*<\/div>/i.exec(chunk);

  return cleanDisplayText(stripRenderedHtml(match?.[1] || ""), { maxLength: 5000 });
}

function renderedXiaohongshuCommentDate(chunk) {
  const dateHtml = /<div\b[^>]*class=["'][^"']*\bdate\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(chunk)?.[1] || "";
  const spans = [...dateHtml.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((match) => stripRenderedHtml(match[1]));
  const location = stripRenderedHtml(/<span\b[^>]*class=["'][^"']*\blocation\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(dateHtml)?.[1] || "");

  return {
    createdAt: spans.find((value) => value && value !== location) || "",
    location,
  };
}

function renderedXiaohongshuLikeCount(chunk) {
  const likeHtml = /<div\b[^>]*class=["'][^"']*\blike\b[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*\breply\b|\<\/div>\s*\<\/div>)/i.exec(chunk)?.[1] || "";
  const count = renderedXiaohongshuLastNumericCount(likeHtml);

  return count ?? null;
}

function renderedXiaohongshuReplyCount(chunk) {
  const count = renderedXiaohongshuLastNumericCount(chunk);

  return count ?? 0;
}

function renderedXiaohongshuLastNumericCount(html) {
  const values = [...String(html || "").matchAll(/<span\b[^>]*class=["'][^"']*\bcount\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)]
    .map((match) => parseXiaohongshuCount(stripRenderedHtml(match[1])))
    .filter((value) => Number.isFinite(value));

  return values.length > 0 ? values[values.length - 1] : null;
}

function renderedXiaohongshuCommentTotal(html) {
  const totalText = /<div\b[^>]*class=["'][^"']*\btotal\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(renderedXiaohongshuCommentsRegion(html))?.[1] || "";

  return parseXiaohongshuCount(stripRenderedHtml(totalText));
}

function searchRenderedClassIndex(html, className) {
  const pattern = new RegExp(`<[^>]+class=["'][^"']*\\b${escapeRegExpLiteral(className)}\\b[^"']*["']`, "i");
  const match = pattern.exec(String(html || ""));

  return match ? match.index : -1;
}

function renderedHtmlAttribute(tag, name) {
  const pattern = new RegExp(`\\b${escapeRegExpLiteral(name)}=["']([^"']*)["']`, "i");
  const value = pattern.exec(String(tag || ""))?.[1] || "";

  return htmlUnescape(value);
}

function stripRenderedHtml(value) {
  return htmlUnescape(String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function resolveChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];

  return candidates.find((candidate) =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    existsSync(candidate),
  ) || "";
}

function isEnabledValue(value) {
  return /^(?:1|true|yes|on|enabled)$/i.test(String(value || "").trim());
}

function escapeRegExpLiteral(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseXiaohongshuCommentApiPayload(payload, source) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;

  if (!data || typeof data !== "object") {
    return null;
  }

  const rawComments = xiaohongshuCommentListFromPayload(data);
  const nextCursor = pickSingleLineText(data.cursor, data.next_cursor, data.nextCursor);
  const hasMore = Boolean(data.has_more ?? data.hasMore);
  const totalCount = firstPresentInt(
    data.total_count,
    data.totalCount,
    data.comment_count,
    data.commentCount,
  );

  return {
    rawComments,
    comments: rawComments.map((comment) => normalizeXiaohongshuComment(comment)).filter((comment) => comment.id),
    nextCursor: hasMore ? nextCursor : "",
    totalCount,
    publicCount: rawComments.length,
    source,
  };
}

function xiaohongshuCommentListFromPayload(data) {
  for (const value of [
    data?.comments,
    data?.comment_list,
    data?.commentList,
    data?.list,
    data?.items,
  ]) {
    if (Array.isArray(value)) {
      return value.filter((comment) => looksLikeXiaohongshuComment(comment));
    }
  }

  return [];
}

function looksLikeXiaohongshuComment(value, noteId = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const ownNoteId = String(value.noteId || value.note_id || "");

  return Boolean(
    (value.id || value.commentId || value.comment_id) &&
      (pickText(value.content, value.text, value.commentContent) || value.userInfo || value.user) &&
      (!noteId || !ownNoteId || ownNoteId === noteId),
  );
}

function normalizeXiaohongshuComment(comment) {
  const author = xiaohongshuCommentAuthor(comment);
  const text = cleanDisplayText(pickText(comment?.content, comment?.text, comment?.commentContent), { maxLength: 5000 });
  const createdAt = normalizeXiaohongshuCommentTime(
    comment?.createTime,
    comment?.createdAt,
    comment?.created_at,
    comment?.time,
  );
  const replies = xiaohongshuCommentReplies(comment)
    .map((reply) => normalizeXiaohongshuComment(reply))
    .filter((reply) => reply.id);
  const authorHandle = pickSingleLineText(author.userId, author.user_id, author.id);
  const authorName = pickSingleLineText(author.nickname, author.nickName, author.name, authorHandle, "小红书用户");
  const id = pickSingleLineText(comment?.id, comment?.commentId, comment?.comment_id) ||
    `xiaohongshu-comment-${hashXiaohongshuComment([authorHandle, authorName, createdAt, text].join("|"))}`;

  return {
    id,
    text,
    author_name: authorName,
    author_handle: authorHandle,
    avatar_url: xiaohongshuCommentAvatarUrl(author),
    created_at: createdAt,
    like_count: parseXiaohongshuCount(comment?.likeCount ?? comment?.like_count ?? comment?.likedCount),
    reply_count: parseXiaohongshuCount(comment?.subCommentCount ?? comment?.sub_comment_count ?? comment?.replyCount) ?? replies.length,
    ip_loc: pickSingleLineText(comment?.ipLocation, comment?.ip_location, comment?.ipLoc, comment?.ip_loc),
    has_voice: false,
    replies,
  };
}

function xiaohongshuCommentAuthor(comment) {
  for (const key of ["userInfo", "user_info", "user", "author"]) {
    const value = comment?.[key];

    if (value && typeof value === "object") {
      return value;
    }
  }

  return {};
}

function xiaohongshuCommentReplies(comment) {
  const replies = [];

  for (const key of ["subComments", "sub_comments", "subCommentList", "sub_comment_list", "replies", "replyList"]) {
    const value = comment?.[key];

    if (Array.isArray(value)) {
      replies.push(...value.filter((reply) => looksLikeXiaohongshuComment(reply)));
    }
  }

  return dedupeXiaohongshuCommentNodes(replies);
}

function xiaohongshuCommentAvatarUrl(author) {
  for (const value of [
    author.image,
    author.avatar,
    author.avatarUrl,
    author.avatar_url,
    author.images,
  ].flatMap((item) => Array.isArray(item) ? item : [item])) {
    const url = typeof value === "object"
      ? pickSingleLineText(value?.url, value?.uri)
      : pickSingleLineText(value);

    if (/^https?:\/\//i.test(url)) {
      return url;
    }
  }

  return "";
}

function normalizeXiaohongshuCommentTime(...values) {
  for (const value of values) {
    if (value == null || value === "") {
      continue;
    }

    if (typeof value === "number" || /^\d+$/.test(String(value))) {
      const number = Number(value);
      const millis = number > 10_000_000_000 ? number : number * 1000;
      const date = new Date(millis);

      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }

    const text = pickSingleLineText(value);

    if (text) {
      return text;
    }
  }

  return null;
}

function dedupeXiaohongshuCommentNodes(comments) {
  const seen = new Set();
  const deduped = [];

  for (const comment of comments) {
    const id = pickSingleLineText(comment?.id, comment?.commentId, comment?.comment_id) ||
      hashXiaohongshuComment(`${xiaohongshuCommentAuthor(comment).userId || ""}|${comment?.createTime || ""}|${comment?.content || ""}`);

    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    deduped.push(comment);
  }

  return deduped;
}

function hashXiaohongshuComment(value) {
  let hash = 5381;

  for (const character of String(value || "")) {
    hash = ((hash << 5) + hash) ^ character.charCodeAt(0);
  }

  return Math.abs(hash >>> 0).toString(36);
}

function randomXiaohongshuTraceId(value) {
  const hash = hashXiaohongshuComment(`${Date.now()}|${value}|${Math.random()}`);

  return hash.padStart(16, "0").slice(0, 16);
}

function xiaohongshuAssetsFromNote(note, filenameBase, mediaHeaders) {
  const assets = [];
  const videoUrls = xiaohongshuVideoUrls(note);

  if (videoUrls.length > 0) {
    assets.push({
      source_url: videoUrls[0].url,
      fallback_urls: videoUrls.slice(1).map((item) => item.url),
      media_type: "video",
      width: videoUrls[0].width,
      height: videoUrls[0].height,
      filename_hint: `${filenameBase}.mp4`,
      request_headers: mediaHeaders,
    });
  }

  const imageList = Array.isArray(note.imageList) ? note.imageList : [];

  imageList.forEach((imageData, index) => {
    const imageUrls = xiaohongshuImageUrls(imageData);
    const imageUrl = imageUrls[0];

    if (imageUrl) {
      assets.push({
        source_url: imageUrl,
        fallback_urls: imageUrls.slice(1),
        media_type: "image",
        width: optionalInt(imageData?.width),
        height: optionalInt(imageData?.height),
        filename_hint: `${filenameBase}_photo_${index + 1}.jpg`,
        request_headers: mediaHeaders,
      });
    }

    const livePhotoUrls = xiaohongshuVideoUrls(imageData);

    if (livePhotoUrls.length > 0) {
      assets.push({
        source_url: livePhotoUrls[0].url,
        fallback_urls: livePhotoUrls.slice(1).map((item) => item.url),
        media_type: "video",
        width: livePhotoUrls[0].width,
        height: livePhotoUrls[0].height,
        filename_hint: `${filenameBase}_live_${index + 1}.mp4`,
        request_headers: mediaHeaders,
      });
    }
  });

  return assets;
}

function mergeXiaohongshuNoteAndHtmlAssets({
  noteAssets,
  htmlAssets,
  preferHtmlImages = false,
}) {
  if (!htmlAssets.length) {
    return noteAssets;
  }

  const noteVideos = noteAssets.filter((asset) => asset.media_type === "video");
  const noteImages = noteAssets.filter((asset) => asset.media_type === "image");
  const noteOtherAssets = noteAssets.filter((asset) => !["image", "video"].includes(asset.media_type));
  const htmlVideos = htmlAssets.filter((asset) => asset.media_type === "video");
  const htmlImages = htmlAssets.filter((asset) => asset.media_type === "image");
  const selectedVideos = noteVideos.length > 0 ? noteVideos : htmlVideos;
  const shouldUseHtmlImages =
    htmlImages.length > 0 &&
    noteVideos.length === 0 &&
    (
      preferHtmlImages ||
      noteImages.length === 0 ||
      htmlImages.length >= noteImages.length
    );
  const selectedImages = shouldUseHtmlImages ? htmlImages : noteImages;

  return dedupeAssets([
    ...selectedVideos,
    ...selectedImages,
    ...noteOtherAssets,
  ]);
}

function xiaohongshuVideoUrls(container) {
  const stream = dig(container, "video", "media", "stream") || container?.stream;
  const generated = xiaohongshuGeneratedVideoUrls(container);

  if (!stream || typeof stream !== "object") {
    return generated;
  }

  const candidates = [...generated];

  for (const codec of ["h264", "av1", "h265", "h266"]) {
    const items = Array.isArray(stream[codec]) ? stream[codec] : [];

    items.forEach((item) => {
      if (!item || typeof item !== "object") {
        return;
      }

      const score = xiaohongshuVideoScore(item, codec);
      const urls = [
        item.mediaUrl,
        item.masterUrl,
        item.url,
        item.backupUrl,
        item.backupUrls,
      ].flatMap((value) => Array.isArray(value) ? value : [value]);

      urls.forEach((url) => {
        if (typeof url === "string" && /^https?:\/\//i.test(url)) {
          candidates.push({
            url: htmlUnescape(url),
            width: optionalInt(item.width),
            height: optionalInt(item.height),
            score,
          });
        }
      });
    });
  }

  const seen = new Set();

  return candidates
    .sort((left, right) => right.score - left.score)
    .filter((item) => {
      if (seen.has(item.url)) {
        return false;
      }

      seen.add(item.url);
      return true;
    });
}

function xiaohongshuGeneratedVideoUrls(container) {
  const key = dig(container, "video", "consumer", "originVideoKey");

  if (typeof key !== "string" || !key.trim()) {
    return [];
  }

  return [{
    url: `https://sns-video-bd.xhscdn.com/${key.trim()}`,
    width: optionalInt(dig(container, "video", "media", "video", "width")),
    height: optionalInt(dig(container, "video", "media", "video", "height")),
    score: 1_000_000_000,
  }];
}

function xiaohongshuVideoScore(item, codec) {
  const codecScore = codec === "h264" ? 30 : codec === "av1" ? 20 : 10;
  const width = optionalInt(item.width) || 0;
  const height = optionalInt(item.height) || 0;
  const bitrate = firstPresentInt(item.avgBitrate, item.videoBitrate, item.bitrate, item.size) || 0;

  return codecScore + width * height + bitrate;
}

function xiaohongshuImageUrls(imageData) {
  if (!imageData || typeof imageData !== "object") {
    return [];
  }

  const candidates = [];

  function add(value, score = 0) {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      const url = htmlUnescape(value);
      const watermarkPenalty = /[?&!/](crd_)?wm/i.test(url) ? -20 : 0;

      candidates.push([score + watermarkPenalty, url]);
    }
  }

  add(imageData.urlDefault, 80);
  add(imageData.urlPre, 70);
  add(imageData.url, 60);
  add(imageData.originalUrl, 90);

  for (const url of [imageData.urlDefault, imageData.url, imageData.urlPre, imageData.originalUrl]) {
    const tokenUrls = xiaohongshuImageTokenUrls(url);

    tokenUrls.forEach((tokenUrl, index) => {
      candidates.push([110 - index, tokenUrl]);
    });
  }

  if (Array.isArray(imageData.infoList)) {
    imageData.infoList.forEach((item) => {
      const scene = String(item?.imageScene || "");
      const sceneScore = /origin|original/i.test(scene) ? 95 : /wm/i.test(scene) ? 45 : 65;

      add(item?.url, sceneScore);

      xiaohongshuImageTokenUrls(item?.url).forEach((tokenUrl, index) => {
        candidates.push([110 - index, tokenUrl]);
      });
    });
  }

  for (const url of [...candidates.map((candidate) => candidate[1])]) {
    const h5OriginalUrls = xiaohongshuH5OriginalImageUrls(url);
    const noWatermarkUrl = xiaohongshuNoWatermarkImageUrl(url);

    h5OriginalUrls.forEach((h5OriginalUrl) => {
      candidates.push([100, h5OriginalUrl]);
    });

    if (noWatermarkUrl) {
      candidates.push([100, noWatermarkUrl]);
    }
  }

  const seen = new Set();

  return candidates
    .sort((left, right) => right[0] - left[0])
    .map((candidate) => candidate[1])
    .filter((url) => {
      if (seen.has(url)) {
        return false;
      }

      seen.add(url);
      return true;
    });
}

function xiaohongshuImageTokenUrls(value) {
  const token = xiaohongshuImageToken(value);

  if (!token) {
    return [];
  }

  return [
    `https://ci.xiaohongshu.com/${token}?imageView2/format/jpg`,
    `https://sns-img-bd.xhscdn.com/${token}`,
  ];
}

function xiaohongshuImageToken(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) {
    return "";
  }

  try {
    const parsed = new URL(htmlUnescape(value));
    const parts = parsed.pathname.split("/").filter(Boolean);

    if (parts.length <= 2) {
      return "";
    }

    const token = parts.slice(2).join("/").split("!", 1)[0].replace(/^\/+/, "");

    return token && !token.includes(".") ? token : "";
  } catch {
    return "";
  }
}

function xiaohongshuNoWatermarkImageUrl(value) {
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value);
    const spectrumMarker = "/spectrum/";
    const markerIndex = parsed.pathname.includes(spectrumMarker)
      ? parsed.pathname.indexOf(spectrumMarker) + spectrumMarker.length
      : parsed.pathname.lastIndexOf("/") + 1;
    const imagePath = markerIndex >= 0 ? parsed.pathname.slice(markerIndex) : "";
    const imageId = imagePath.split("!", 1)[0].replace(/^\/+/, "");

    if (!imageId || imageId.includes(".")) {
      return "";
    }

    return `https://ci.xiaohongshu.com/notes_pre_post/${imageId}?imageView2/format/jpg`;
  } catch {
    return "";
  }
}

function xiaohongshuHtmlAssets(text, shortcode, pageUrl, settings = {}) {
  const headers = xiaohongshuMediaHeaders(pageUrl, settings);
  const assets = [];
  const imageUrls = xiaohongshuHtmlImageUrls(text);
  const videoUrls = xiaohongshuHtmlVideoUrls(text);

  videoUrls.forEach((url, index) => {
    assets.push({
      source_url: url,
      media_type: "video",
      filename_hint: `xiaohongshu_${shortcode}_h5_video_${index + 1}.mp4`,
      request_headers: headers,
    });
  });

  imageUrls.forEach((url, index) => {
    const imageCandidates = xiaohongshuPreferredImageUrls(url);
    const sourceUrl = imageCandidates[0];

    assets.push({
      source_url: sourceUrl,
      fallback_urls: imageCandidates.slice(1),
      media_type: "image",
      filename_hint: `xiaohongshu_${shortcode}_h5_photo_${index + 1}.jpg`,
      request_headers: headers,
    });
  });

  return dedupeAssets(assets);
}

function xiaohongshuPreferredImageUrls(url) {
  return uniqueXiaohongshuUrls([
    ...xiaohongshuH5OriginalImageUrls(url),
    xiaohongshuNoWatermarkImageUrl(url),
    url,
  ]);
}

function xiaohongshuHtmlImageUrls(text) {
  const candidates = [];

  for (const match of String(text || "").matchAll(/<img\b[^>]*(?:data-xhs-img|notes_pre_post)[^>]*>/gi)) {
    const src = htmlAttribute(match[0], "src");

    if (isXiaohongshuNoteImageUrl(src) || isXiaohongshuH5NoteImageUrl(src)) {
      candidates.push(normalizeXiaohongshuCdnUrl(src));
    }
  }

  for (const match of String(text || "").matchAll(/https?:\\?\/\\?\/[^"'<>\\\s]+notes_pre_post[^"'<>\\\s]*/gi)) {
    const url = decodeXiaohongshuEmbeddedUrl(match[0]);

    if (isXiaohongshuNoteImageUrl(url)) {
      candidates.push(normalizeXiaohongshuCdnUrl(url));
    }
  }

  return uniqueXiaohongshuUrls(candidates);
}

function xiaohongshuHtmlVideoUrls(text) {
  const candidates = [];

  for (const match of String(text || "").matchAll(/<video\b[^>]*>/gi)) {
    const src = htmlAttribute(match[0], "src");

    if (isXiaohongshuVideoUrl(src)) {
      candidates.push(normalizeXiaohongshuCdnUrl(src));
    }
  }

  for (const match of String(text || "").matchAll(/https?:\\?\/\\?\/[^"'<>\\\s]+(?:\.mp4|sns-video|v\.xhscdn)[^"'<>\\\s]*/gi)) {
    const url = decodeXiaohongshuEmbeddedUrl(match[0]);

    if (isXiaohongshuVideoUrl(url)) {
      candidates.push(normalizeXiaohongshuCdnUrl(url));
    }
  }

  return uniqueXiaohongshuUrls(candidates);
}

function htmlAttribute(tag, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  const match = pattern.exec(tag);

  return match ? htmlUnescape(match[2]) : "";
}

function decodeXiaohongshuEmbeddedUrl(value) {
  return htmlUnescape(String(value || ""))
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/");
}

function normalizeXiaohongshuCdnUrl(value) {
  return decodeXiaohongshuEmbeddedUrl(value);
}

function uniqueXiaohongshuUrls(urls) {
  const seen = new Set();
  const output = [];

  for (const url of urls) {
    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    output.push(url);
  }

  return output;
}

function isXiaohongshuNoteImageUrl(value) {
  return /^https?:\/\//i.test(String(value || "")) &&
    /xhscdn\.com/i.test(value) &&
    /\/notes_pre_post\//i.test(value);
}

function isXiaohongshuH5NoteImageUrl(value) {
  return /^https?:\/\//i.test(String(value || "")) &&
    /xhscdn\.com/i.test(value) &&
    /\/[^/?#]+![^/?#]+(?:[?&#]|$)/i.test(value) &&
    !/avatar/i.test(value);
}

function xiaohongshuH5OriginalImageUrl(value) {
  return xiaohongshuH5OriginalImageUrls(value)[0] || "";
}

function xiaohongshuH5OriginalImageUrls(value) {
  if (!isXiaohongshuH5NoteImageUrl(value)) {
    return [];
  }

  try {
    const parsed = new URL(value);
    const imagePath = xiaohongshuH5ImageObjectPath(parsed.pathname);

    if (!imagePath) {
      return [];
    }

    return [
      `https://sns-img-qc.xhscdn.com/${imagePath}?imageView2/format/jpg`,
      `https://sns-img-bd.xhscdn.com/${imagePath}?imageView2/format/jpg`,
      `https://sns-img-hw.xhscdn.com/${imagePath}?imageView2/format/jpg`,
      `https://ci.xiaohongshu.com/${imagePath}?imageView2/format/jpg`,
    ];
  } catch {
    return [];
  }
}

function xiaohongshuH5ImageObjectPath(pathname) {
  const parts = String(pathname || "")
    .split("/")
    .filter(Boolean);

  if (parts.length === 0) {
    return "";
  }

  const objectParts = parts.length > 2 ? parts.slice(2) : parts;
  const lastIndex = objectParts.length - 1;

  objectParts[lastIndex] = objectParts[lastIndex].split("!", 1)[0];

  if (
    objectParts.some((part) => !part || part.includes(".") || /[?#]/.test(part))
  ) {
    return "";
  }

  return objectParts.join("/");
}

function isXiaohongshuVideoUrl(value) {
  return /^https?:\/\//i.test(String(value || "")) &&
    /xhscdn\.com/i.test(value) &&
    /(?:\.mp4|sns-video|v\.xhscdn)/i.test(value);
}

function xiaohongshuMetaAssets(text, shortcode, pageUrl, settings = {}) {
  const headers = xiaohongshuMediaHeaders(pageUrl, settings);
  const assets = [];
  const video = metaContents(text, ["og:video", "og:video:url", "og:video:secure_url"])[0];
  const image = metaContents(text, ["og:image", "og:image:url", "og:image:secure_url"])[0];

  if (video) {
    assets.push({
      source_url: video,
      media_type: "video",
      filename_hint: `xiaohongshu_${shortcode}.mp4`,
      request_headers: headers,
    });
  }

  if (image) {
    assets.push({
      source_url: image,
      media_type: "image",
      filename_hint: `xiaohongshu_${shortcode}.jpg`,
      request_headers: headers,
    });
  }

  return assets;
}

function looksLikeXiaohongshuVerification(text) {
  return looksLikeXiaohongshuRestrictedText(text);
}

function looksLikeXiaohongshuRestrictedText(text) {
  return /captcha|verify|安全验证|滑块验证|环境异常|访问频繁|\/404\/sec_|error_code=300031|当前笔记暂时无法浏览|当前内容仅支持在小红书 APP 内查看|sec_WZRZJKCu/i.test(String(text || ""));
}

function postInfoFromXiaohongshu(note, metrics, creatorHandle) {
  const user = note?.user && typeof note.user === "object" ? note.user : {};
  const body = pickText(note?.desc, note?.description, note?.content);

  return createPostInfo(
    {
      title: pickSingleLineText(note?.title, titleFromBody(body)),
      author: pickSingleLineText(user.nickname, user.nickName, creatorHandle),
      author_handle: pickSingleLineText(user.userId, user.user_id, creatorHandle),
      body,
      tags: normalizeTags(xiaohongshuTags(note), body),
      metrics,
      source: metrics?.source || "xiaohongshu_public_best_effort",
    },
    { metrics, creatorHandle, source: metrics?.source || "xiaohongshu_public_best_effort" },
  );
}

function xiaohongshuTags(note) {
  const values = [];

  for (const key of ["tagList", "hashTagList", "hashTags", "topicList"]) {
    if (Array.isArray(note?.[key])) {
      values.push(...note[key]);
    }
  }

  return values;
}

function metricsFromXiaohongshu(detail) {
  const stats = detail?.interactInfo && typeof detail.interactInfo === "object" ? detail.interactInfo : {};

  return {
    like_count: parseXiaohongshuCount(stats.likedCount ?? stats.likeCount),
    comment_count: parseXiaohongshuCount(stats.commentCount),
    view_count: parseXiaohongshuCount(stats.viewCount),
    save_count: parseXiaohongshuCount(stats.collectedCount ?? stats.collectCount),
    share_count: parseXiaohongshuCount(stats.shareCount),
    source: "xiaohongshu_public_best_effort",
  };
}

function parseXiaohongshuCount(value) {
  if (value == null || value === "" || typeof value === "boolean") {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const text = String(value).trim().replaceAll(",", "");

  if (!text || ["赞", "收藏", "评论", "分享"].includes(text)) {
    return null;
  }

  const match = /^(\d+(?:\.\d+)?)(万|w|k|千)?$/i.exec(text);

  if (!match) {
    return optionalInt(text);
  }

  const number = Number.parseFloat(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "万" || unit === "w" ? 10_000 : unit === "k" || unit === "千" ? 1_000 : 1;

  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

function xiaohongshuMediaHeaders(pageUrl, settings = {}) {
  return withCookieHeader({
    Referer: pageUrl,
    Origin: "https://www.xiaohongshu.com",
    "user-agent": XIAOHONGSHU_HEADERS["user-agent"],
    accept: "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8",
    "accept-language": XIAOHONGSHU_HEADERS["accept-language"],
  }, xiaohongshuCookieHeader(settings));
}

export function isXiaohongshuHost(host) {
  return [
    "xiaohongshu.com",
    "www.xiaohongshu.com",
    "m.xiaohongshu.com",
    "xhslink.com",
    "www.xhslink.com",
    "xhslink.cn",
    "www.xhslink.cn",
    "xhs.cn",
    "www.xhs.cn",
    "rednote.com",
    "www.rednote.com",
  ].includes(host) || host.endsWith(".xiaohongshu.com") || host.endsWith(".rednote.com");
}

function isXiaohongshuShortHost(host) {
  return [
    "xhslink.com",
    "www.xhslink.com",
    "xhslink.cn",
    "www.xhslink.cn",
    "xhs.cn",
    "www.xhs.cn",
  ].includes(host);
}
