const DEFAULT_APP_NAME = "LinkMigo";
const MAX_APP_NAME_LENGTH = 80;
export const DEFAULT_URL_PLACEHOLDER =
  "支持 Instagram、Threads、小红书、小宇宙、V2EX、Reddit、Pinterest、YouTube、TikTok、抖音、快手、视频号、B 站、A 站链接...";
export const DEFAULT_URL_PLACEHOLDER_EN =
  "Paste Instagram, Xiaohongshu, Xiaoyuzhou, V2EX, Reddit, Pinterest, YouTube, TikTok, Douyin, Kuaishou, WeChat Channels, Bilibili, or AcFun URL...";
const MAX_URL_PLACEHOLDER_LENGTH = 240;
const DEFAULT_THEME = "default";
const SUPPORTED_THEMES = new Set([DEFAULT_THEME, "cohere"]);

export function getAppName() {
  return cleanAppName(process.env.LINKMIGO_APP_NAME || process.env.APP_NAME) || DEFAULT_APP_NAME;
}

export function getUrlPlaceholder() {
  return cleanUrlPlaceholder(process.env.LINKMIGO_URL_PLACEHOLDER) || DEFAULT_URL_PLACEHOLDER;
}

export function getUrlPlaceholderEn() {
  return cleanUrlPlaceholder(process.env.LINKMIGO_URL_PLACEHOLDER_EN) || DEFAULT_URL_PLACEHOLDER_EN;
}

/**
 * Selects the global UI system at the server boundary so the client bundle
 * receives a stable, validated value. `THEME` is supported as a concise alias
 * for deployments that already standardise on that variable name.
 */
export function getAppTheme() {
  const value = String(process.env.LINKMIGO_THEME || process.env.THEME || "")
    .trim()
    .toLowerCase();

  return SUPPORTED_THEMES.has(value) ? value : DEFAULT_THEME;
}

function cleanAppName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_APP_NAME_LENGTH);
}

function cleanUrlPlaceholder(value) {
  return String(value || "")
    .trim()
    .replace(/[\r\n]+/g, " ")
    .slice(0, MAX_URL_PLACEHOLDER_LENGTH);
}
