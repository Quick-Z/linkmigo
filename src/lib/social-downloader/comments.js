import { resolveBilibiliComments } from "./bilibili";
import { resolveInstagramComments } from "./instagram";
import { resolveRedditComments } from "./reddit";
import { resolveV2exComments } from "./v2ex";
import { resolveXiaoyuzhouComments } from "./xiaoyuzhou";

const COMMENT_RESOLVERS = {
  bilibili: resolveBilibiliComments,
  instagram: resolveInstagramComments,
  reddit: resolveRedditComments,
  v2ex: resolveV2exComments,
  xiaoyuzhou: resolveXiaoyuzhouComments,
};

export async function resolveSocialComments(normalized, options = {}, settings = {}) {
  const resolver = COMMENT_RESOLVERS[normalized.platform];

  if (resolver) {
    return await resolver(normalized, options, settings);
  }

  return emptyCommentsPayload(normalized, `${normalized.platform}_comments_public_snapshot_unavailable`);
}

function emptyCommentsPayload(normalized, source) {
  return {
    platform: normalized.platform,
    shortcode: normalized.shortcode,
    canonical_url: normalized.canonical_url,
    comments: [],
    next_cursor: null,
    has_more: false,
    total_count: null,
    public_count: 0,
    is_partial_public_snapshot: true,
    source,
  };
}
