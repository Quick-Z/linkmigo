import { htmlUnescape } from "./utils";

const defaultMetrics = {
  like_count: null,
  comment_count: null,
  view_count: null,
  save_count: null,
  share_count: null,
  source: "public_best_effort",
};

export function createPostInfo(input = {}, options = {}) {
  const metrics = normalizeMetrics(input.metrics ?? options.metrics);
  const body = cleanDisplayText(input.body, { maxLength: 8000 });
  const title = cleanSingleLineText(input.title, { maxLength: 220 });
  const fallbackHandle = cleanSingleLineText(options.creatorHandle, { maxLength: 120 });
  const authorHandle = cleanSingleLineText(input.author_handle, { maxLength: 120 }) || fallbackHandle;
  const author = cleanSingleLineText(input.author, { maxLength: 160 }) || authorHandle;
  const tags = normalizeTags(input.tags, body);

  return {
    title,
    author,
    author_handle: authorHandle,
    body,
    tags,
    metrics,
    source: cleanSingleLineText(input.source || options.source || metrics.source, { maxLength: 120 }) || "public_best_effort",
  };
}

export function hasPostInfoContent(postInfo) {
  if (!postInfo || typeof postInfo !== "object") {
    return false;
  }

  return Boolean(
    postInfo.title ||
    postInfo.author ||
    postInfo.author_handle ||
    postInfo.body ||
    (Array.isArray(postInfo.tags) && postInfo.tags.length > 0),
  );
}

export function pickText(...values) {
  for (const value of values.flat()) {
    const text = cleanDisplayText(value);

    if (text) {
      return text;
    }
  }

  return "";
}

export function pickSingleLineText(...values) {
  for (const value of values.flat()) {
    const text = cleanSingleLineText(value);

    if (text) {
      return text;
    }
  }

  return "";
}

export function cleanDisplayText(value, options = {}) {
  const { maxLength = 5000 } = options;

  if (value == null || typeof value === "boolean") {
    return "";
  }

  const raw = Array.isArray(value) ? value.join("\n") : String(value);
  const normalized = htmlUnescape(raw)
    .replace(/\\n/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  return truncateText(normalized, maxLength);
}

export function cleanSingleLineText(value, options = {}) {
  const { maxLength = 180 } = options;
  const text = cleanDisplayText(value, { maxLength });

  return truncateText(text.replace(/\s+/g, " ").trim(), maxLength);
}

export function normalizeTags(values = [], extraText = "") {
  const tags = [];
  const seen = new Set();

  for (const value of [
    ...(Array.isArray(values) ? values : [values]),
    ...tagsFromText(extraText),
  ]) {
    const tag = tagText(value);

    if (!tag) {
      continue;
    }

    const key = tag.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    tags.push(tag);

    if (tags.length >= 32) {
      break;
    }
  }

  return tags;
}

export function tagsFromText(text) {
  const normalized = cleanDisplayText(text, { maxLength: 8000 });
  const tags = [];
  const pattern = /(^|[\s([{])#([\p{L}\p{N}_][\p{L}\p{N}_.-]{0,63})/gu;
  let match;

  while ((match = pattern.exec(normalized))) {
    tags.push(match[2]);
  }

  return tags;
}

function tagText(value) {
  if (value == null || typeof value === "boolean") {
    return "";
  }

  const raw = typeof value === "object"
    ? value.name ?? value.tagName ?? value.tag_name ?? value.hashtagName ?? value.hashtag_name ?? value.title ?? value.text ?? value.id
    : value;
  const tag = cleanSingleLineText(raw, { maxLength: 64 })
    .replace(/^#+/, "")
    .replace(/\s+/g, "");

  return tag && !/^https?:\/\//i.test(tag) ? tag : "";
}

function normalizeMetrics(metrics) {
  if (!metrics || typeof metrics !== "object") {
    return { ...defaultMetrics };
  }

  return {
    like_count: normalizedMetric(metrics.like_count),
    comment_count: normalizedMetric(metrics.comment_count),
    view_count: normalizedMetric(metrics.view_count),
    save_count: normalizedMetric(metrics.save_count),
    share_count: normalizedMetric(metrics.share_count),
    source: cleanSingleLineText(metrics.source, { maxLength: 120 }) || defaultMetrics.source,
  };
}

function normalizedMetric(value) {
  if (value == null || value === "" || typeof value === "boolean") {
    return null;
  }

  const number = Number.parseInt(String(value), 10);

  return Number.isFinite(number) && number >= 0 ? number : null;
}

function truncateText(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
