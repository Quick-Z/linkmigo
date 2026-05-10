export const ErrorCode = {
  CACHE_EXPIRED: "CACHE_EXPIRED",
  DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
  INVALID_JSON: "INVALID_JSON",
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  NO_MEDIA_FOUND: "NO_MEDIA_FOUND",
  REQUEST_FAILED: "REQUEST_FAILED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  UNSUPPORTED_URL: "UNSUPPORTED_URL",
  UPSTREAM_BLOCKED: "UPSTREAM_BLOCKED",
};

export class AppError extends Error {
  constructor(code, message, status = 500, details) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function errorPayload(error) {
  const payload = {
    error: {
      code: error.code ?? ErrorCode.INTERNAL_SERVER_ERROR,
      message: error.message || "服务暂时不可用，请稍后再试。",
    },
  };

  if (error.details) {
    payload.error.details = error.details;
  }

  return payload;
}

export function toAppError(error) {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError(
    ErrorCode.INTERNAL_SERVER_ERROR,
    "服务暂时不可用，请稍后再试。",
    500,
    getErrorDetail(error),
  );
}

export function getErrorDetail(error) {
  if (error instanceof Error) {
    if (error.cause && typeof error.cause === "object" && "code" in error.cause) {
      return `${error.message} (${String(error.cause.code)})`;
    }

    return error.message;
  }

  return "未知错误";
}
