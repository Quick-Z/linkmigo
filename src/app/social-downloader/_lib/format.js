export function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return path;
}

export function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatCompactNumber(value, language = "zh") {
  if (!Number.isFinite(value ?? NaN) || value == null || value < 0) {
    return "/";
  }

  return new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US", {
    notation: "compact",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value);
}

export function formatExpiry(value, language = "zh") {
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

export function errorLabel(error, language = "zh") {
  const labels = {
    zh: {
      UNSUPPORTED_URL: "链接格式暂不支持",
      LOGIN_REQUIRED: "页面需要登录",
      NO_MEDIA_FOUND: "没有找到媒体资源",
      UPSTREAM_BLOCKED: "上游访问受限",
      DOWNLOAD_FAILED: "媒体下载失败",
      CACHE_EXPIRED: "缓存已过期",
      SERVICE_UNAVAILABLE: "服务暂不可用",
      INVALID_JSON: "请求格式无效",
    },
    en: {
      UNSUPPORTED_URL: "Unsupported link format.",
      LOGIN_REQUIRED: "Page requires login.",
      NO_MEDIA_FOUND: "No media found.",
      UPSTREAM_BLOCKED: "Upstream access blocked.",
      DOWNLOAD_FAILED: "Media download failed.",
      CACHE_EXPIRED: "Cache expired.",
      SERVICE_UNAVAILABLE: "Service unavailable.",
      INVALID_JSON: "Invalid request format.",
    },
  };
  const current = labels[language] ?? labels.zh;

  return current[error.code] ?? (language === "en" ? "Request failed." : "请求失败");
}

export function getApiError(caught) {
  if (caught && typeof caught === "object" && "error" in caught) {
    const payload = caught.error;

    if (payload?.message) {
      return {
        code: payload.code ?? "REQUEST_FAILED",
        message: payload.message,
        details: payload.details,
      };
    }
  }

  if (caught instanceof Error) {
    return {
      code: "REQUEST_FAILED",
      message: caught.message,
    };
  }

  return {
    code: "REQUEST_FAILED",
    message: "请求失败，请稍后重试。",
  };
}
