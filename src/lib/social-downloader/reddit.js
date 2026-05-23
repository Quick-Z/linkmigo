import { URL } from "node:url";

import { AppError, ErrorCode } from "./errors";
import {
  dedupeAssets,
  dig,
  fetchWithTimeout,
  getAttribute,
  htmlUnescape,
  metaContents,
  optionalInt,
  PAGE_HEADERS,
} from "./utils";
import { createPostInfo, normalizeTags, pickSingleLineText, pickText } from "./post-info";

const REDDIT_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "sh.reddit.com",
  "np.reddit.com",
  "m.reddit.com",
  "redd.it",
  "www.redd.it",
]);

const REDDIT_MEDIA_HOSTS = new Set([
  "i.redd.it",
  "preview.redd.it",
  "external-preview.redd.it",
  "v.redd.it",
  "media.redd.it",
  "reddit.com",
  "www.reddit.com",
  "redditmedia.com",
  "www.redditmedia.com",
  "a.thumbs.redditmedia.com",
  "b.thumbs.redditmedia.com",
  "styles.redditmedia.com",
]);

const REDDIT_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const REDDIT_INSTALLED_CLIENT_GRANT = "https://oauth.reddit.com/grants/installed_client";

let redditOAuthCache = {
  key: "",
  token: "",
  expiresAt: 0,
};

export function normalizeRedditUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean).map(stripRedditPathPart);

  if (isRedditShortHost(host) && parts[0]) {
    return redditNormalizedPost(parts[0], {
      canonicalUrl: `https://www.reddit.com/comments/${parts[0]}/`,
      kind: "short",
    });
  }

  if (parts[0] === "gallery" && parts[1]) {
    return redditNormalizedPost(parts[1], {
      canonicalUrl: `https://www.reddit.com/gallery/${parts[1]}`,
      kind: "gallery",
    });
  }

  const commentsIndex = parts.findIndex((part) => part === "comments");
  const postId = commentsIndex >= 0 ? parts[commentsIndex + 1] : "";

  if (postId) {
    const subreddit = parts[0] === "r" ? parts[1] : "";
    const slug = parts[commentsIndex + 2] && parts[commentsIndex + 2] !== ".json"
      ? parts[commentsIndex + 2]
      : "";
    const canonicalPath = subreddit
      ? `/r/${subreddit}/comments/${postId}/${slug ? `${slug}/` : ""}`
      : `/comments/${postId}/`;

    return redditNormalizedPost(postId, {
      canonicalUrl: `https://www.reddit.com${canonicalPath}`,
      kind: "post",
    });
  }

  throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 Reddit 公开帖子、图集或 redd.it 短链接。", 400);
}

export async function resolveRedditPost(normalized, settings) {
  const { post, pageUrl, source } = await requestRedditPost(normalized, settings);
  const postForMedia = primaryMediaPost(post);
  let assets = await assetsFromRedditPost(postForMedia, settings, pageUrl);

  if (assets.length === 0 && postForMedia !== post) {
    assets = await assetsFromRedditPost(post, settings, pageUrl);
  }

  if (assets.length === 0 && source !== "html") {
    const htmlFallback = await requestRedditHtmlPost(normalized, settings).catch(() => null);

    if (htmlFallback?.post) {
      const htmlAssets = await assetsFromRedditPost(htmlFallback.post, settings, htmlFallback.pageUrl);

      if (htmlAssets.length > 0) {
        assets = htmlAssets;
      }
    }
  }

  if (assets.length === 0) {
    if (post.over_18 && looksLikeAgeRestricted(post)) {
      throw new AppError(ErrorCode.LOGIN_REQUIRED, "这个 Reddit 帖子需要登录或年龄验证。", 403);
    }

    const textAsset = await redditTextAssetFromPost(post, normalized, settings);

    if (textAsset) {
      assets = [textAsset];
    }
  }

  if (assets.length === 0) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "Reddit 帖子中没有发现可下载媒体。", 404);
  }

  const metrics = metricsFromReddit(post);
  const creatorHandle = pickSingleLineText(post.author);

  return {
    assets,
    metrics,
    creator_handle: creatorHandle,
    post_info: postInfoFromReddit(post, metrics, creatorHandle),
  };
}

async function redditTextAssetFromPost(post, normalized, settings) {
  const title = pickSingleLineText(post?.title);
  const body = pickText(post?.selftext_html, post?.selftext);

  if (!title && !body) {
    return null;
  }

  const commentsPayload = await resolveRedditComments(normalized, { limit: 30 }, settings).catch(() => null);
  const text = redditDiscussionText({
    body,
    comments: commentsPayload?.comments ?? [],
    post,
    title,
  });

  return {
    source_url: `text://reddit/${post?.id || normalized.shortcode}`,
    media_type: "text",
    filename_hint: `reddit_${post?.id || normalized.shortcode}_discussion.txt`,
    text_content: text,
  };
}

function redditDiscussionText({ body, comments, post, title }) {
  const lines = [
    title,
    "",
    `URL: ${new URL(post?.permalink || `/comments/${post?.id || ""}/`, "https://www.reddit.com").toString()}`,
    post?.subreddit_name_prefixed ? `Subreddit: ${post.subreddit_name_prefixed}` : "",
    post?.author ? `Author: u/${post.author}` : "",
    Number.isFinite(post?.score) ? `Score: ${post.score}` : "",
    Number.isFinite(post?.num_comments) ? `Comments: ${post.num_comments}` : "",
    "",
    "Post",
    "----",
    body || "(no body)",
  ].filter((line) => line != null);

  if (comments.length > 0) {
    lines.push("", "Top comments", "------------");

    comments.forEach((comment, index) => {
      lines.push(
        "",
        `${index + 1}. ${comment.author_name || "Reddit user"}${comment.like_count != null ? ` (${comment.like_count} upvotes)` : ""}`,
        comment.text || "",
      );

      for (const reply of comment.replies || []) {
        lines.push("", `   - ${reply.author_name || "Reddit user"}: ${reply.text || ""}`);
      }
    });
  }

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

export async function resolveRedditComments(normalized, options = {}, settings = {}) {
  const data = await requestRedditJson(
    `https://api.reddit.com/comments/${encodeURIComponent(normalized.shortcode)}.json?raw_json=1&limit=500&depth=3`,
    settings,
  );
  const post = extractRedditPost(data?.[0], normalized.shortcode) || extractRedditPost(data, normalized.shortcode);
  const publicComments = redditTopLevelComments(data?.[1]);
  const limit = normalizeRedditCommentLimit(options.limit);
  const offset = normalizeRedditCommentCursor(options.cursor);
  const endOffset = offset + limit;
  const comments = publicComments
    .slice(offset, endOffset)
    .map((comment) => normalizeRedditComment(comment))
    .filter((comment) => comment.id);
  const totalCount = optionalInt(post?.num_comments) ?? publicComments.length;
  const nextCursor = endOffset < publicComments.length ? String(endOffset) : null;

  return {
    platform: "reddit",
    shortcode: normalized.shortcode,
    canonical_url: normalized.canonical_url,
    comments,
    next_cursor: nextCursor,
    has_more: Boolean(nextCursor),
    total_count: totalCount,
    public_count: publicComments.length,
    is_partial_public_snapshot: totalCount > publicComments.length,
    source: "reddit_public_json_comments",
  };
}

async function requestRedditPost(normalized, settings) {
  const jsonUrls = redditJsonUrls(normalized, settings);
  const errors = [];

  for (const jsonUrl of jsonUrls) {
    try {
      const data = await requestRedditJson(jsonUrl, settings);
      const post = extractRedditPost(data, normalized.shortcode);

      if (post) {
        const permalink = typeof post.permalink === "string" ? post.permalink : "";
        const pageUrl = permalink
          ? new URL(permalink, "https://www.reddit.com").toString()
          : normalized.canonical_url;

        return { post, pageUrl, source: "json" };
      }
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    return await requestRedditHtmlPost(normalized, settings);
  } catch (error) {
    errors.push(error);
  }

  const selectedError = selectRedditRequestError(errors, settings);

  if (selectedError) {
    throw selectedError;
  }

  throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个 Reddit 帖子。", 404);
}

function normalizeRedditCommentLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return 12;
  }

  return Math.max(1, Math.min(30, parsed));
}

function normalizeRedditCommentCursor(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return parsed;
}

function redditTopLevelComments(listing) {
  const children = Array.isArray(listing?.data?.children) ? listing.data.children : [];

  return children
    .filter((child) => child?.kind === "t1" && child?.data)
    .map((child) => child.data);
}

function normalizeRedditComment(comment) {
  const replies = redditTopLevelComments(comment?.replies)
    .slice(0, 3)
    .map((reply) => normalizeRedditComment(reply))
    .filter((reply) => reply.id);

  return {
    id: String(comment?.id || comment?.name || ""),
    text: pickText(comment?.body_html, comment?.body),
    author_name: pickSingleLineText(comment?.author) || "Reddit user",
    author_handle: pickSingleLineText(comment?.author),
    avatar_url: "",
    created_at: redditTimestamp(comment?.created_utc ?? comment?.created),
    like_count: optionalInt(comment?.ups) ?? optionalInt(comment?.score),
    reply_count: optionalInt(comment?.num_comments) ?? replies.length,
    ip_loc: pickSingleLineText(comment?.subreddit_name_prefixed),
    has_voice: false,
    replies,
  };
}

function redditTimestamp(value) {
  const timestamp = Number(value);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const date = new Date(timestamp * 1000);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function redditJsonUrls(normalized, settings) {
  const urls = new Set();
  const canonical = new URL(normalized.canonical_url);

  if (hasRedditOAuthSettings(settings)) {
    const oauthPath = redditOAuthPath(canonical.pathname, normalized.shortcode);

    urls.add(`https://oauth.reddit.com${oauthPath}.json?raw_json=1`);
    urls.add(`https://oauth.reddit.com/api/info.json?id=t3_${normalized.shortcode}&raw_json=1`);
  }

  if (canonical.pathname.includes("/comments/") || canonical.pathname.includes("/gallery/")) {
    const path = canonical.pathname.replace(/\/+$/g, "");

    urls.add(`https://api.reddit.com${path}?raw_json=1`);
    urls.add(`https://api.reddit.com${path}.json?raw_json=1`);
    urls.add(`https://www.reddit.com${path}.json?raw_json=1`);
    urls.add(`https://old.reddit.com${path}.json?raw_json=1`);
  }

  urls.add(`https://api.reddit.com/comments/${normalized.shortcode}?raw_json=1`);
  urls.add(`https://api.reddit.com/api/info/?id=t3_${normalized.shortcode}&raw_json=1`);
  urls.add(`https://www.reddit.com/api/info.json?id=t3_${normalized.shortcode}&raw_json=1`);
  urls.add(`https://www.reddit.com/comments/${normalized.shortcode}.json?raw_json=1`);
  urls.add(`https://old.reddit.com/comments/${normalized.shortcode}.json?raw_json=1`);
  urls.add(`https://www.reddit.com/by_id/t3_${normalized.shortcode}.json?raw_json=1`);

  return [...urls];
}

async function requestRedditHtmlPost(normalized, settings) {
  const response = await requestRedditHtml(normalized.canonical_url, settings);
  const post = extractRedditPostFromHtml(response.text, normalized, response.pageUrl);

  if (!post) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个 Reddit 帖子。", 404);
  }

  return {
    post,
    pageUrl: response.pageUrl,
    source: "html",
  };
}

async function requestRedditJson(jsonUrl, settings) {
  let response;
  const isOAuthRequest = isRedditOAuthUrl(jsonUrl);

  try {
    const headers = isOAuthRequest
      ? await redditOAuthJsonHeaders(settings)
      : redditJsonHeaders(jsonUrl);

    response = await fetchWithTimeout(
      jsonUrl,
      {
        cache: "no-store",
        headers,
      },
      settings.httpTimeoutMs,
    );
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (error?.name === "AbortError") {
      throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "Reddit 页面请求超时。", 504);
    }

    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "无法访问 Reddit 页面。", 502, {
      hint: redditAccessHint(settings),
    });
  }

  if ([401, 403].includes(response.status)) {
    const message = isOAuthRequest
      ? "Reddit OAuth 授权失败或没有权限访问这个帖子。"
      : "Reddit 页面需要登录或拒绝了公开访问。";

    throw new AppError(ErrorCode.LOGIN_REQUIRED, message, 403, {
      hint: redditAccessHint(settings),
    });
  }

  if (response.status === 404) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个 Reddit 帖子。", 404);
  }

  if (response.status === 429) {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "Reddit 对当前请求进行了限流。", 429);
  }

  if (response.status >= 400) {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, `Reddit 返回异常状态码 ${response.status}。`, 502);
  }

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "Reddit 返回内容无法解析。", 502);
  }
}

async function requestRedditHtml(pageUrl, settings) {
  let response;

  try {
    response = await fetchWithTimeout(
      pageUrl,
      {
        cache: "no-store",
        headers: {
          ...PAGE_HEADERS,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      settings.httpTimeoutMs,
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "Reddit 页面请求超时。", 504);
    }

    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "无法访问 Reddit 页面。", 502, {
      hint: redditAccessHint(settings),
    });
  }

  if ([401, 403].includes(response.status)) {
    throw new AppError(ErrorCode.LOGIN_REQUIRED, "Reddit 页面需要登录或拒绝了公开访问。", 403, {
      hint: redditAccessHint(settings),
    });
  }

  if (response.status === 404) {
    throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个 Reddit 帖子。", 404);
  }

  if (response.status === 429) {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "Reddit 对当前请求进行了限流。", 429);
  }

  if (response.status >= 400) {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, `Reddit 返回异常状态码 ${response.status}。`, 502);
  }

  return {
    pageUrl: response.url || pageUrl,
    text: await response.text(),
  };
}

function redditOAuthPath(pathname, shortcode) {
  const path = String(pathname || "").replace(/\/+$/g, "");

  if (path.includes("/comments/")) {
    return path;
  }

  return `/comments/${shortcode}`;
}

function isRedditOAuthUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase() === "oauth.reddit.com";
  } catch {
    return false;
  }
}

function hasRedditOAuthSettings(settings) {
  return Boolean(settings?.redditClientId);
}

async function redditOAuthJsonHeaders(settings) {
  return {
    ...PAGE_HEADERS,
    accept: "application/json,text/plain,*/*",
    "user-agent": redditUserAgent(settings),
    authorization: `Bearer ${await redditOAuthAccessToken(settings)}`,
  };
}

async function redditOAuthAccessToken(settings) {
  if (!settings?.redditClientId) {
    throw new AppError(
      ErrorCode.LOGIN_REQUIRED,
      "Reddit OAuth 缺少 client id。",
      403,
      { hint: redditOAuthHint() },
    );
  }

  const key = [
    settings.redditClientId,
    settings.redditClientSecret ? "secret" : "",
    settings.redditRefreshToken ? "refresh" : "anonymous",
    redditUserAgent(settings),
  ].join(":");
  const now = Date.now();

  if (redditOAuthCache.key === key && redditOAuthCache.token && redditOAuthCache.expiresAt - 60_000 > now) {
    return redditOAuthCache.token;
  }

  let response;

  try {
    response = await fetchWithTimeout(
      "https://www.reddit.com/api/v1/access_token",
      {
        method: "POST",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": redditUserAgent(settings),
          authorization: `Basic ${Buffer.from(`${settings.redditClientId}:${settings.redditClientSecret || ""}`).toString("base64")}`,
        },
        body: redditOAuthBody(settings),
      },
      settings.httpTimeoutMs,
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "Reddit OAuth 请求超时。", 504);
    }

    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "无法访问 Reddit OAuth。", 502, {
      hint: redditAccessHint(settings),
    });
  }

  if ([401, 403].includes(response.status)) {
    throw new AppError(ErrorCode.LOGIN_REQUIRED, "Reddit OAuth client id、secret 或 refresh token 无效。", 403, {
      hint: redditOAuthHint(),
    });
  }

  if (response.status >= 400) {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, `Reddit OAuth 返回异常状态码 ${response.status}。`, 502, {
      hint: redditOAuthHint(),
    });
  }

  let payload;

  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new AppError(ErrorCode.UPSTREAM_BLOCKED, "Reddit OAuth 返回内容无法解析。", 502);
  }

  const token = typeof payload?.access_token === "string" ? payload.access_token : "";

  if (!token) {
    throw new AppError(ErrorCode.LOGIN_REQUIRED, "Reddit OAuth 没有返回 access token。", 403, {
      hint: redditOAuthHint(),
    });
  }

  redditOAuthCache = {
    key,
    token,
    expiresAt: now + Math.max(60, optionalInt(payload.expires_in) || 3600) * 1000,
  };

  return token;
}

function redditOAuthBody(settings) {
  const body = new URLSearchParams();

  if (settings.redditRefreshToken) {
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", settings.redditRefreshToken);
    return body;
  }

  if (settings.redditClientSecret) {
    body.set("grant_type", "client_credentials");
    return body;
  }

  body.set("grant_type", REDDIT_INSTALLED_CLIENT_GRANT);
  body.set("device_id", "DO_NOT_TRACK_THIS_DEVICE");

  return body;
}

function redditUserAgent(settings) {
  return pickSingleLineText(settings?.redditUserAgent) || "web:linkmigo:0.1.0 (by /u/linkmigo_user)";
}

function redditAccessHint(settings) {
  if (hasRedditOAuthSettings(settings)) {
    return "请确认 Reddit OAuth 配置可用、User-Agent 唯一，并确认服务器网络或 SOCIAL_PROXY_URL 可访问 Reddit。";
  }

  return redditOAuthHint();
}

function redditOAuthHint() {
  return "请在 .env.local 配置 SOCIAL_REDDIT_CLIENT_ID 和 SOCIAL_REDDIT_USER_AGENT；如使用脚本应用，再配置 SOCIAL_REDDIT_CLIENT_SECRET。配置后重启服务。";
}

function selectRedditRequestError(errors, settings) {
  const appErrors = errors.filter((error) => error instanceof AppError);
  const loginError = appErrors.find((error) => error.code === ErrorCode.LOGIN_REQUIRED);

  if (loginError && !hasRedditOAuthSettings(settings)) {
    return new AppError(
      ErrorCode.LOGIN_REQUIRED,
      "Reddit 拒绝了未授权的公开请求，需要配置 Reddit OAuth 后再解析。",
      403,
      { hint: redditOAuthHint() },
    );
  }

  return (
    loginError ||
    appErrors.find((error) => error.code === ErrorCode.UPSTREAM_BLOCKED) ||
    appErrors.find((error) => error.code === ErrorCode.NO_MEDIA_FOUND) ||
    appErrors.at(-1) ||
    null
  );
}

function extractRedditPost(data, postId) {
  if (!data || typeof data !== "object") {
    return null;
  }

  if (Array.isArray(data)) {
    return extractRedditPost(data[0], postId);
  }

  if (data.kind === "t3" && data.data && typeof data.data === "object") {
    return data.data;
  }

  const children = Array.isArray(data?.data?.children) ? data.data.children : [];
  const exact = children.find((child) => child?.kind === "t3" && child?.data?.id === postId);
  const fallback = children.find((child) => child?.kind === "t3" && child?.data);

  return (exact || fallback)?.data ?? null;
}

function extractRedditPostFromHtml(text, normalized, pageUrl) {
  const shortcode = normalized.shortcode;
  const shredditPost = extractShredditPost(text, shortcode, pageUrl);
  const metaPost = extractMetaPost(text, normalized, pageUrl);

  if (!shredditPost && !metaPost) {
    return null;
  }

  return mergeHtmlPosts(metaPost, shredditPost, shortcode, pageUrl);
}

function extractShredditPost(text, shortcode, pageUrl) {
  const postPattern = /<shreddit-post\b[^>]*>/gi;
  let match;

  while ((match = postPattern.exec(text))) {
    const tag = match[0];
    const postId = stripThingPrefix(
      getAttribute(tag, "post-id") ||
      getAttribute(tag, "thing-id") ||
      getAttribute(tag, "id"),
    );

    if (postId && postId !== shortcode) {
      continue;
    }

    const contentUrl = firstRedditUrl(
      getAttribute(tag, "content-href"),
      getAttribute(tag, "url"),
      getAttribute(tag, "href"),
    );
    const permalink = firstRedditPermalink(
      getAttribute(tag, "permalink"),
      getAttribute(tag, "post-url"),
      pageUrl,
    );
    const subreddit = pickSingleLineText(
      getAttribute(tag, "subreddit-name"),
      stripSubredditPrefix(getAttribute(tag, "subreddit-prefixed-name")),
    );

    return {
      id: shortcode,
      title: pickSingleLineText(
        getAttribute(tag, "post-title"),
        getAttribute(tag, "title"),
      ),
      author: stripAuthorPrefix(getAttribute(tag, "author")),
      subreddit,
      subreddit_name_prefixed: subreddit ? `r/${subreddit}` : getAttribute(tag, "subreddit-prefixed-name"),
      permalink,
      url: contentUrl,
      url_overridden_by_dest: contentUrl,
      post_hint: contentUrl ? (isLikelyVideoUrl(contentUrl) ? "hosted:video" : "image") : "",
      preview: previewFromUrls([contentUrl]),
      score: optionalInt(getAttribute(tag, "score")),
      ups: optionalInt(getAttribute(tag, "score")),
      num_comments: optionalInt(getAttribute(tag, "comment-count")),
      over_18: getAttribute(tag, "over-18") === "true" || getAttribute(tag, "nsfw") === "true",
    };
  }

  return null;
}

function extractMetaPost(text, normalized, pageUrl) {
  const imageUrls = metaContents(text, [
    "og:image",
    "og:image:url",
    "og:image:secure_url",
    "twitter:image",
    "twitter:image:src",
  ]).map(firstRedditUrl).filter(isLikelyImageAssetUrl);
  const videoUrls = metaContents(text, [
    "og:video",
    "og:video:url",
    "og:video:secure_url",
    "twitter:player:stream",
  ]).map(firstRedditUrl).filter(isLikelyVideoUrl);
  const mediaUrl = firstRedditUrl(...videoUrls, ...imageUrls);

  if (!mediaUrl) {
    return null;
  }

  const title = pickSingleLineText(
    ...metaContents(text, ["og:title", "twitter:title"]),
  );
  const description = pickText(
    ...metaContents(text, ["og:description", "twitter:description", "description"]),
  );
  const permalink = firstRedditPermalink(
    metaContents(text, ["og:url", "twitter:url"])[0],
    pageUrl,
  );

  return {
    id: normalized.shortcode,
    title,
    selftext: description,
    permalink,
    url: mediaUrl,
    url_overridden_by_dest: mediaUrl,
    post_hint: isLikelyVideoUrl(mediaUrl) ? "hosted:video" : "image",
    preview: previewFromUrls(imageUrls),
  };
}

function mergeHtmlPosts(metaPost, shredditPost, shortcode, pageUrl) {
  const base = {
    id: shortcode,
    permalink: new URL(pageUrl).pathname,
    url: pageUrl,
  };
  const merged = {
    ...base,
    ...(metaPost || {}),
    ...(shredditPost || {}),
  };

  merged.preview = mergePreviewImages(metaPost?.preview, shredditPost?.preview);

  if (!merged.url_overridden_by_dest && merged.preview?.images?.length) {
    merged.url_overridden_by_dest = firstRedditUrl(dig(merged, "preview", "images", 0, "source", "url"));
  }

  if (!merged.url) {
    merged.url = merged.url_overridden_by_dest || pageUrl;
  }

  if (!merged.post_hint && merged.url_overridden_by_dest) {
    merged.post_hint = isLikelyVideoUrl(merged.url_overridden_by_dest) ? "hosted:video" : "image";
  }

  return merged;
}

async function assetsFromRedditPost(post, settings, pageUrl) {
  if (!post || typeof post !== "object") {
    return [];
  }

  const videoAssets = await videoAssetsFromRedditPost(post, settings, pageUrl);

  if (videoAssets.length > 0) {
    return dedupeAssets(videoAssets);
  }

  const galleryAssets = galleryAssetsFromRedditPost(post, pageUrl);

  if (galleryAssets.length > 0) {
    return dedupeAssets(galleryAssets);
  }

  return dedupeAssets(imageAssetsFromRedditPost(post, pageUrl));
}

async function videoAssetsFromRedditPost(post, settings, pageUrl) {
  const videos = redditVideoPayloads(post);
  const assets = [];

  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index];
    const sourceUrl = firstRedditUrl(video.fallback_url, video.scrubber_media_url, video.hls_url);

    if (!sourceUrl) {
      continue;
    }

    const hlsUrl = firstRedditUrl(video.hls_url);
    const dashUrl = firstRedditUrl(video.dash_url);
    const fallbackUrls = [hlsUrl].filter((url) => url && url !== sourceUrl);
    const height = optionalInt(video.height);
    const width = optionalInt(video.width);
    const asset = {
      source_url: sourceUrl,
      fallback_urls: fallbackUrls,
      media_type: "video",
      width,
      height,
      filename_hint: `reddit_${post.id}_${height || index + 1}.mp4`,
      request_headers: redditMediaHeaders(pageUrl),
      is_hls: isRedditHlsUrl(sourceUrl),
    };

    if (!video.is_gif && dashUrl) {
      const audioUrls = await redditAudioUrlsFromDash(dashUrl, settings, pageUrl);

      if (audioUrls.length > 0) {
        asset.audio_source_url = audioUrls[0];
        asset.audio_fallback_urls = audioUrls.slice(1);
        asset.audio_filename_hint = `reddit_${post.id}_audio.m4a`;
        asset.audio_request_headers = redditMediaHeaders(pageUrl);
        asset.optional_audio = true;
      }
    }

    assets.push(asset);
  }

  return assets;
}

function galleryAssetsFromRedditPost(post, pageUrl) {
  const mediaMetadata = post.media_metadata && typeof post.media_metadata === "object"
    ? post.media_metadata
    : {};
  const orderedItems = Array.isArray(post.gallery_data?.items) ? post.gallery_data.items : [];
  const mediaIds = orderedItems.length > 0
    ? orderedItems.map((item) => item?.media_id).filter(Boolean)
    : Object.keys(mediaMetadata);
  const assets = [];

  mediaIds.forEach((mediaId, index) => {
    const metadata = mediaMetadata[mediaId];
    const asset = assetFromRedditMediaMetadata({
      metadata,
      mediaId,
      postId: post.id,
      index,
      pageUrl,
    });

    if (asset) {
      assets.push(asset);
    }
  });

  return assets;
}

function imageAssetsFromRedditPost(post, pageUrl) {
  const assets = [];
  const directUrls = [
    post.url_overridden_by_dest,
    post.url,
    dig(post, "crosspost_parent_list", 0, "url_overridden_by_dest"),
    dig(post, "crosspost_parent_list", 0, "url"),
  ]
    .map(firstRedditUrl)
    .filter(Boolean);
  const thumbnailUrls = [
    dig(post, "thumbnail"),
    dig(post, "media", "oembed", "thumbnail_url"),
    dig(post, "secure_media", "oembed", "thumbnail_url"),
  ]
    .map(firstRedditUrl)
    .filter(Boolean);
  const previewUrls = redditPreviewImageUrls(post);
  const candidateUrls = uniqueRedditUrls([
    ...directUrls,
    ...previewUrls,
    ...thumbnailUrls,
  ]);

  for (const candidateUrl of candidateUrls) {
    const originalUrl = redditOriginalImageUrlFromPreview(candidateUrl);
    const url = originalUrl || candidateUrl;

    if (!isLikelyImageAssetUrl(url)) {
      continue;
    }

    assets.push({
      source_url: url,
      fallback_urls: uniqueRedditUrls([
        candidateUrl,
        ...previewUrls,
      ]).filter((candidate) => candidate !== url),
      media_type: "image",
      width: optionalInt(dig(post, "preview", "images", 0, "source", "width")),
      height: optionalInt(dig(post, "preview", "images", 0, "source", "height")),
      filename_hint: `reddit_${post.id}_1${extensionForRedditUrl(url, "image")}`,
      request_headers: redditMediaHeaders(pageUrl),
    });

    break;
  }

  if (assets.length > 0) {
    return assets;
  }

  return previewUrls.map((url, index) => {
    const originalUrl = redditOriginalImageUrlFromPreview(url);

    return {
      source_url: originalUrl || url,
      fallback_urls: originalUrl ? [url] : [],
      media_type: "image",
      width: optionalInt(dig(post, "preview", "images", index, "source", "width")),
      height: optionalInt(dig(post, "preview", "images", index, "source", "height")),
      filename_hint: `reddit_${post.id}_${index + 1}${extensionForRedditUrl(originalUrl || url, "image")}`,
      request_headers: redditMediaHeaders(pageUrl),
    };
  });
}

function assetFromRedditMediaMetadata({ metadata, mediaId, postId, index, pageUrl }) {
  if (!metadata || typeof metadata !== "object" || metadata.status === "failed") {
    return null;
  }

  const sourceUrl = firstRedditUrl(
    dig(metadata, "s", "u"),
    dig(metadata, "s", "gif"),
    dig(metadata, "s", "mp4"),
    dig(metadata, "s", "url"),
    Array.isArray(metadata.o) ? metadata.o.at(-1)?.u : "",
    Array.isArray(metadata.p) ? metadata.p.at(-1)?.u : "",
  );

  if (!sourceUrl) {
    return null;
  }

  const originalUrl = redditOriginalGalleryUrl(mediaId, metadata, sourceUrl);
  const mediaType = isLikelyVideoUrl(sourceUrl) || String(metadata.e || "").toLowerCase().includes("video")
    ? "video"
    : "image";
  const extension = extensionForRedditUrl(originalUrl || sourceUrl, mediaType, metadata.m);

  return {
    source_url: originalUrl || sourceUrl,
    fallback_urls: originalUrl ? [sourceUrl] : [],
    media_type: mediaType,
    width: optionalInt(dig(metadata, "s", "x")),
    height: optionalInt(dig(metadata, "s", "y")),
    filename_hint: `reddit_${postId}_${index + 1}${extension}`,
    request_headers: redditMediaHeaders(pageUrl),
  };
}

function redditVideoPayloads(post) {
  const candidates = [
    dig(post, "secure_media", "reddit_video"),
    dig(post, "media", "reddit_video"),
    dig(post, "preview", "reddit_video_preview"),
    dig(post, "crosspost_parent_list", 0, "secure_media", "reddit_video"),
    dig(post, "crosspost_parent_list", 0, "media", "reddit_video"),
    dig(post, "crosspost_parent_list", 0, "preview", "reddit_video_preview"),
  ];
  const seen = new Set();

  return candidates.filter((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return false;
    }

    const key = firstRedditUrl(candidate.fallback_url, candidate.hls_url, candidate.dash_url);

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function redditAudioUrlsFromDash(dashUrl, settings, pageUrl) {
  try {
    const response = await fetchWithTimeout(
      dashUrl,
      {
        cache: "no-store",
        headers: redditMediaHeaders(pageUrl),
      },
      settings.httpTimeoutMs,
    );

    if (response.status >= 400) {
      return [];
    }

    return parseRedditDashAudioUrls(await response.text(), dashUrl);
  } catch {
    return [];
  }
}

function parseRedditDashAudioUrls(text, dashUrl) {
  const urls = [];
  const adaptationSets = [...String(text || "").matchAll(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/gi)];

  for (const match of adaptationSets) {
    const block = match[0];

    if (!/contentType=["']audio["']|mimeType=["']audio\//i.test(block)) {
      continue;
    }

    const representations = [...block.matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi)];

    if (representations.length === 0) {
      addRedditDashAudioUrl(urls, block, dashUrl, 0);
      continue;
    }

    for (const representation of representations) {
      addRedditDashAudioUrl(
        urls,
        representation[2],
        dashUrl,
        optionalInt(/bandwidth=["'](\d+)["']/i.exec(representation[1])?.[1]) || 0,
      );
    }
  }

  return [...new Map(
    urls
      .filter((item) => item.url)
      .sort((left, right) => right.bandwidth - left.bandwidth)
      .map((item) => [item.url, item.url]),
  ).values()];
}

function addRedditDashAudioUrl(urls, block, dashUrl, bandwidth) {
  const baseUrl = /<BaseURL>([\s\S]*?)<\/BaseURL>/i.exec(block)?.[1];

  if (!baseUrl) {
    return;
  }

  try {
    urls.push({
      url: new URL(htmlUnescape(baseUrl.trim()), dashUrl).toString(),
      bandwidth,
    });
  } catch {
    // Ignore malformed DASH BaseURL entries.
  }
}

function redditPreviewImageUrls(post) {
  const images = Array.isArray(post?.preview?.images) ? post.preview.images : [];
  const urls = [];

  for (const image of images) {
    const sourceUrl = firstRedditUrl(dig(image, "source", "url"));

    if (sourceUrl) {
      urls.push(sourceUrl);
    }

    const resolutions = Array.isArray(image.resolutions) ? image.resolutions : [];

    for (const resolution of resolutions) {
      const resolutionUrl = firstRedditUrl(resolution?.url);

      if (resolutionUrl) {
        urls.push(resolutionUrl);
      }
    }

    for (const variant of Object.values(image.variants || {})) {
      const variantUrl = firstRedditUrl(dig(variant, "source", "url"));

      if (variantUrl) {
        urls.push(variantUrl);
      }
    }
  }

  return uniqueRedditUrls(urls).filter(isLikelyRedditImageUrl);
}

function redditOriginalGalleryUrl(mediaId, metadata, fallbackUrl) {
  if (!mediaId || !/^[A-Za-z0-9_-]+$/.test(mediaId)) {
    return "";
  }

  const extension = extensionForRedditUrl(fallbackUrl, "image", metadata?.m);

  if (!REDDIT_IMAGE_EXTENSIONS.has(extension)) {
    return "";
  }

  return `https://i.redd.it/${mediaId}${extension}`;
}

function primaryMediaPost(post) {
  const crosspost = Array.isArray(post?.crosspost_parent_list)
    ? post.crosspost_parent_list.find((item) => item && typeof item === "object")
    : null;

  return crosspost || post;
}

function metricsFromReddit(post) {
  return {
    like_count: optionalInt(post.score ?? post.ups),
    comment_count: optionalInt(post.num_comments),
    view_count: optionalInt(post.view_count),
    save_count: null,
    share_count: optionalInt(post.num_crossposts),
    source: "reddit_public_best_effort",
  };
}

function postInfoFromReddit(post, metrics, creatorHandle) {
  const subreddit = pickSingleLineText(post.subreddit_name_prefixed, post.subreddit ? `r/${post.subreddit}` : "");
  const flair = pickSingleLineText(post.link_flair_text);
  const body = pickText(post.selftext, post.title);

  return createPostInfo(
    {
      title: pickSingleLineText(post.title),
      author: pickSingleLineText(post.author),
      author_handle: creatorHandle,
      body,
      tags: normalizeTags([subreddit, flair].filter(Boolean), body),
      metrics,
      source: "reddit_public_best_effort",
    },
    { metrics, creatorHandle, source: "reddit_public_best_effort" },
  );
}

function redditNormalizedPost(postId, options) {
  const shortcode = stripRedditPathPart(postId).toLowerCase();

  if (!/^[a-z0-9]{4,16}$/.test(shortcode)) {
    throw new AppError(ErrorCode.UNSUPPORTED_URL, "仅支持 Reddit 公开帖子、图集或 redd.it 短链接。", 400);
  }

  return {
    canonical_url: options.canonicalUrl,
    shortcode,
    kind: options.kind,
    platform: "reddit",
  };
}

function stripRedditPathPart(value) {
  return String(value || "").replace(/\.json$/i, "");
}

function stripThingPrefix(value) {
  return stripRedditPathPart(String(value || "").replace(/^t3_/i, "")).toLowerCase();
}

function stripAuthorPrefix(value) {
  return pickSingleLineText(String(value || "").replace(/^u\//i, ""));
}

function stripSubredditPrefix(value) {
  return pickSingleLineText(String(value || "").replace(/^r\//i, ""));
}

function firstRedditPermalink(...values) {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }

    try {
      const parsed = new URL(htmlUnescape(value.trim()), "https://www.reddit.com");

      if (isRedditHost(parsed.hostname.toLowerCase())) {
        return parsed.pathname;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return "";
}

function firstRedditUrl(...values) {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const url = normalizeRedditMediaUrl(htmlUnescape(value).replace(/\\\//g, "/").trim());

    if (/^https?:\/\//i.test(url)) {
      return url;
    }
  }

  return "";
}

function normalizeRedditMediaUrl(value) {
  if (!/^https?:\/\//i.test(value)) {
    return value;
  }

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    if (isRedditHost(host) && parsed.pathname === "/media") {
      const embeddedUrl = htmlUnescape(parsed.searchParams.get("url") || "").replace(/\\\//g, "/").trim();

      if (/^https?:\/\//i.test(embeddedUrl) && embeddedUrl !== value) {
        return embeddedUrl;
      }
    }
  } catch {
    // Keep the original value.
  }

  return value;
}

function previewFromUrls(urls) {
  const images = uniqueRedditUrls(urls)
    .filter(isLikelyRedditImageUrl)
    .map((url) => ({
      source: {
        url,
        width: null,
        height: null,
      },
      resolutions: [],
      variants: {},
      id: "",
    }));

  return images.length ? { images } : null;
}

function mergePreviewImages(...previews) {
  const images = [];
  const seen = new Set();

  for (const preview of previews) {
    const currentImages = Array.isArray(preview?.images) ? preview.images : [];

    for (const image of currentImages) {
      const url = firstRedditUrl(dig(image, "source", "url"));

      if (!url || seen.has(url)) {
        continue;
      }

      seen.add(url);
      images.push(image);
    }
  }

  return images.length ? { images } : null;
}

function uniqueRedditUrls(urls) {
  const seen = new Set();
  const unique = [];

  for (const value of urls) {
    const url = firstRedditUrl(value);

    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    unique.push(url);
  }

  return unique;
}

function extensionForRedditUrl(url, mediaType, contentType = "") {
  const normalizedContentType = String(contentType || "").split(";", 1)[0].trim().toLowerCase();

  if (normalizedContentType === "image/png") {
    return ".png";
  }

  if (normalizedContentType === "image/webp") {
    return ".webp";
  }

  if (normalizedContentType === "image/gif") {
    return ".gif";
  }

  if (
    normalizedContentType === "image/jpeg" ||
    normalizedContentType === "image/jpg" ||
    normalizedContentType === "image/pjpeg"
  ) {
    return ".jpg";
  }

  try {
    const parsed = new URL(url);
    const extension = parsed.pathname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];

    if (extension) {
      return extension === ".jpeg" ? ".jpg" : extension;
    }

    const format = (parsed.searchParams.get("format") || "").toLowerCase();

    if (["jpg", "jpeg", "pjpg"].includes(format)) {
      return ".jpg";
    }

    if (["png", "webp", "gif"].includes(format)) {
      return `.${format}`;
    }
  } catch {
    // Fall through to media-type default.
  }

  return mediaType === "video" ? ".mp4" : ".jpg";
}

function redditOriginalImageUrlFromPreview(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const filename = parsed.pathname.split("/").filter(Boolean).at(-1) || "";
    const extension = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];

    if (host !== "preview.redd.it" || !filename || !REDDIT_IMAGE_EXTENSIONS.has(extension)) {
      return "";
    }

    return `https://i.redd.it/${filename}`;
  } catch {
    return "";
  }
}

function isLikelyImageAssetUrl(url) {
  return isLikelyRedditImageUrl(url) || hasImageExtension(url);
}

function isLikelyRedditImageUrl(url) {
  try {
    const normalized = normalizeRedditMediaUrl(url);
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    const extension = parsed.pathname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];

    if (REDDIT_IMAGE_EXTENSIONS.has(extension)) {
      return true;
    }

    if (host === "i.redd.it" || host === "preview.redd.it" || host === "external-preview.redd.it") {
      return true;
    }

    return REDDIT_MEDIA_HOSTS.has(host) && (
      parsed.searchParams.has("format") ||
      parsed.searchParams.has("url") ||
      parsed.pathname.includes("/preview/") ||
      host.includes("preview.redd.it")
    );
  } catch {
    return false;
  }
}

function hasImageExtension(url) {
  try {
    const extension = new URL(url).pathname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];

    return REDDIT_IMAGE_EXTENSIONS.has(extension);
  } catch {
    return false;
  }
}

function isLikelyVideoUrl(url) {
  try {
    return [".mp4", ".m4v", ".webm", ".mov"].some((extension) =>
      new URL(url).pathname.toLowerCase().endsWith(extension),
    );
  } catch {
    return false;
  }
}

function isRedditHlsUrl(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return /\.m3u8(?:$|\?)/i.test(String(url || ""));
  }
}

function looksLikeAgeRestricted(post) {
  return !post.url && !post.url_overridden_by_dest && !post.media && !post.secure_media;
}

function redditJsonHeaders(pageUrl) {
  return {
    ...PAGE_HEADERS,
    accept: "application/json,text/plain,*/*",
    referer: redditOrigin(pageUrl),
  };
}

function redditMediaHeaders(pageUrl) {
  return {
    Referer: pageUrl,
    Origin: "https://www.reddit.com",
  };
}

function redditOrigin(pageUrl) {
  try {
    const parsed = new URL(pageUrl);

    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return "https://www.reddit.com/";
  }
}

function isRedditShortHost(host) {
  return host === "redd.it" || host === "www.redd.it";
}

export function isRedditHost(host) {
  return REDDIT_HOSTS.has(host) || host.endsWith(".reddit.com");
}
