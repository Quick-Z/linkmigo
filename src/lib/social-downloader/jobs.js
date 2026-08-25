import crypto from "node:crypto";

import { ErrorCode, getErrorDetail, toAppError } from "./errors";
import { getSocialDownloaderSettings } from "./settings";
import { resolveUrl } from "./service";
import { normalizeSocialUrl } from "./social";
import { writeUserActionLog } from "../user-action-logger";
import { xiaohongshuSessionCookie } from "./xiaohongshu-sessions";

const resolveJobsKey = "__linkmigoSocialResolveJobs";
const resolveSchedulerKey = "__linkmigoSocialResolveScheduler";
const jobTtlMs = 30 * 60 * 1000;
const callbackMaxAttempts = 3;
const callbackTimeoutMs = 10_000;

export function startResolveJob(url, options = {}) {
  cleanupJobs();

  const now = new Date().toISOString();
  const platform = resolveJobPlatform(url);
  const callback = createCallbackState(options);
  const job = {
    job_id: crypto.randomUUID().replaceAll("-", ""),
    platform,
    status: "queued",
    phase: "queued",
    progress: {
      mode: "indeterminate",
      phase: "queued",
      percent: null,
      downloaded_bytes: 0,
      total_bytes: null,
      asset_index: null,
      asset_count: null,
    },
    result: null,
    error: null,
    callback,
    queue_position: null,
    created_at: now,
    updated_at: now,
  };

  getJobStore().set(job.job_id, job);
  enqueueResolveJob(job.job_id, url, platform, options.session_id || "");

  return snapshotJob(job);
}

export function getResolveJob(jobId) {
  cleanupJobs();

  if (!jobId || typeof jobId !== "string") {
    return null;
  }

  const job = getJobStore().get(jobId);

  return job ? snapshotJob(job) : null;
}

async function runResolveJob(jobId, url, sessionId = "") {
  updateJob(jobId, {
    status: "running",
    phase: "resolving",
    queue_position: null,
    progress: {
      mode: "indeterminate",
      phase: "resolving",
      percent: null,
      downloaded_bytes: 0,
      total_bytes: null,
      asset_index: null,
      asset_count: null,
    },
  });

  try {
    const result = await resolveUrl(url, {
      sessionId,
      xiaohongshuCookie: sessionId ? xiaohongshuSessionCookie(sessionId) : "",
      onProgress: (progress) => {
        updateJobProgress(jobId, progress);
      },
    });
    const summary = jobResultSummary(result);

    updateJob(jobId, {
      status: "completed",
      phase: "completed",
      queue_position: null,
      progress: {
        mode: "percent",
        phase: "completed",
        percent: 100,
        downloaded_bytes: summary.downloadedBytes,
        total_bytes: summary.totalBytes,
        asset_index: summary.assetIndex,
        asset_count: summary.assetCount,
      },
      result,
      error: null,
    });
    scheduleJobCallback(jobId);
  } catch (error) {
    const appError = toAppError(error);

    await writeUserActionLog({
      action: "resolve_job_failed",
      level: "error",
      status: "error",
      details: {
        url,
        job_id: jobId,
        error_code: appError.code,
        error_message: appError.message,
        error_status: appError.status,
        error_details: appError.details,
      },
    });

    updateJob(jobId, {
      status: "failed",
      phase: "failed",
      queue_position: null,
      error: {
        code: appError.code ?? ErrorCode.INTERNAL_SERVER_ERROR,
        message: appError.message || "服务暂时不可用，请稍后再试。",
        details: appError.details,
      },
    });
    scheduleJobCallback(jobId);
  }
}

function enqueueResolveJob(jobId, url, platform, sessionId = "") {
  const scheduler = getScheduler();

  scheduler.pending.push({ jobId, url, platform, sessionId });
  updateQueuedJobs();
  queueMicrotask(drainResolveJobs);
}

function drainResolveJobs() {
  const scheduler = getScheduler();
  const concurrency = resolveConcurrency();

  while (scheduler.activeCount < concurrency && scheduler.pending.length > 0) {
    const nextIndex = scheduler.pending.findIndex((item) => canRunResolveJob(item.platform));

    if (nextIndex < 0) {
      break;
    }

    const [next] = scheduler.pending.splice(nextIndex, 1);

    if (!next || !getJobStore().has(next.jobId)) {
      continue;
    }

    scheduler.activeCount += 1;
    incrementActivePlatform(next.platform);
    runResolveJob(next.jobId, next.url, next.sessionId).finally(() => {
      scheduler.activeCount = Math.max(0, scheduler.activeCount - 1);
      decrementActivePlatform(next.platform);
      cleanupJobs();
      updateQueuedJobs();
      queueMicrotask(drainResolveJobs);
    });
  }

  updateQueuedJobs();
}

function canRunResolveJob(platform) {
  return activePlatformCount(platform) < platformResolveConcurrency(platform);
}

function updateQueuedJobs() {
  const scheduler = getScheduler();

  scheduler.pending.forEach((item, index) => {
    updateJob(item.jobId, {
      status: "queued",
      phase: "queued",
      queue_position: index + 1,
      progress: {
        mode: "indeterminate",
        phase: "queued",
        percent: null,
        downloaded_bytes: 0,
        total_bytes: null,
        asset_index: null,
        asset_count: null,
      },
    });
  });
}

function updateJobProgress(jobId, progress) {
  const job = getJobStore().get(jobId);

  if (!job || job.status === "completed" || job.status === "failed") {
    return;
  }

  const normalized = normalizeProgress(progress, job.progress);

  updateJob(jobId, {
    status: "running",
    phase: normalized.phase,
    progress: normalized,
  });
}

function normalizeProgress(progress, previous = {}) {
  const totalBytes = positiveNumber(progress?.total_bytes);
  const downloadedBytes = Math.max(0, Number(progress?.downloaded_bytes) || 0);
  const rawPercent = totalBytes
    ? Math.floor((Math.min(downloadedBytes, totalBytes) / totalBytes) * 100)
    : null;
  const percent = rawPercent == null ? null : Math.max(0, Math.min(99, rawPercent));

  return {
    mode: percent == null ? "indeterminate" : "percent",
    phase: progress?.phase || previous?.phase || "running",
    percent,
    downloaded_bytes: downloadedBytes,
    total_bytes: totalBytes,
    asset_index: positiveNumber(progress?.asset_index),
    asset_count: positiveNumber(progress?.asset_count),
  };
}

function updateJob(jobId, patch) {
  const store = getJobStore();
  const job = store.get(jobId);

  if (!job) {
    return null;
  }

  const updated = {
    ...job,
    ...patch,
    updated_at: new Date().toISOString(),
  };

  store.set(jobId, updated);

  return updated;
}

function updateJobCallback(jobId, patch) {
  const job = getJobStore().get(jobId);

  if (!job?.callback) {
    return null;
  }

  return updateJob(jobId, {
    callback: {
      ...job.callback,
      ...patch,
    },
  });
}

function snapshotJob(job) {
  const snapshot = JSON.parse(JSON.stringify(job));

  if (snapshot.callback) {
    delete snapshot.callback.public_base_url;
  }

  return snapshot;
}

function getJobStore() {
  if (!globalThis[resolveJobsKey]) {
    globalThis[resolveJobsKey] = new Map();
  }

  return globalThis[resolveJobsKey];
}

function getScheduler() {
  if (!globalThis[resolveSchedulerKey]) {
    globalThis[resolveSchedulerKey] = {
      activeCount: 0,
      activeByPlatform: new Map(),
      pending: [],
    };
  }

  if (!globalThis[resolveSchedulerKey].activeByPlatform) {
    globalThis[resolveSchedulerKey].activeByPlatform = new Map();
  }

  return globalThis[resolveSchedulerKey];
}

function resolveConcurrency() {
  return Math.max(1, getSocialDownloaderSettings().resolveConcurrency || 1);
}

function platformResolveConcurrency(platform) {
  const settings = getSocialDownloaderSettings();

  if (platform === "xiaohongshu") {
    return Math.max(1, settings.xiaohongshuResolveConcurrency || 1);
  }

  return resolveConcurrency();
}

function activePlatformCount(platform) {
  if (!platform) {
    return 0;
  }

  return getScheduler().activeByPlatform.get(platform) || 0;
}

function incrementActivePlatform(platform) {
  if (!platform) {
    return;
  }

  const scheduler = getScheduler();
  scheduler.activeByPlatform.set(platform, activePlatformCount(platform) + 1);
}

function decrementActivePlatform(platform) {
  if (!platform) {
    return;
  }

  const scheduler = getScheduler();
  const nextCount = Math.max(0, activePlatformCount(platform) - 1);

  if (nextCount === 0) {
    scheduler.activeByPlatform.delete(platform);
    return;
  }

  scheduler.activeByPlatform.set(platform, nextCount);
}

function resolveJobPlatform(url) {
  try {
    return normalizeSocialUrl(url).platform || "";
  } catch {
    return "";
  }
}

function cleanupJobs() {
  const store = getJobStore();
  const scheduler = getScheduler();
  const now = Date.now();

  for (const [jobId, job] of store) {
    if (now - Date.parse(job.updated_at || job.created_at || 0) > jobTtlMs) {
      store.delete(jobId);
    }
  }

  scheduler.pending = scheduler.pending.filter((item) => store.has(item.jobId));
}

function positiveNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? number : null;
}

function createCallbackState(options) {
  const url = typeof options.callbackUrl === "string" ? options.callbackUrl.trim() : "";

  if (!url) {
    return null;
  }

  return {
    url,
    public_base_url: normalizePublicBaseUrl(
      options.publicBaseUrl || getSocialDownloaderSettings().publicBaseUrl,
    ),
    status: "pending",
    attempt_count: 0,
    last_error: null,
    notified_at: null,
  };
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw);

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }

    return parsed.origin;
  } catch {
    return "";
  }
}

function scheduleJobCallback(jobId) {
  const job = getJobStore().get(jobId);

  if (!job?.callback?.url) {
    return;
  }

  queueMicrotask(() => {
    notifyJobCallback(jobId).catch(async (error) => {
      await writeUserActionLog({
        action: "resolve_job_callback_unhandled_error",
        level: "error",
        status: "error",
        details: {
          job_id: jobId,
          error_message: getErrorDetail(error),
        },
      });
    });
  });
}

async function notifyJobCallback(jobId) {
  for (let attempt = 1; attempt <= callbackMaxAttempts; attempt += 1) {
    const job = getJobStore().get(jobId);

    if (!job?.callback?.url || !["completed", "failed"].includes(job.status)) {
      return;
    }

    updateJobCallback(jobId, {
      status: "sending",
      attempt_count: attempt,
      last_error: null,
    });

    try {
      const response = await postJobCallback(job.callback.url, callbackPayload(job));

      if (!response.ok) {
        throw new Error(`回调接口返回 HTTP ${response.status}`);
      }

      updateJobCallback(jobId, {
        status: "succeeded",
        notified_at: new Date().toISOString(),
        last_error: null,
      });

      await writeUserActionLog({
        action: "resolve_job_callback_succeeded",
        status: "ok",
        details: {
          job_id: jobId,
          callback_url: job.callback.url,
          attempt_count: attempt,
          status_code: response.status,
        },
      });

      return;
    } catch (error) {
      const lastError = getErrorDetail(error);

      updateJobCallback(jobId, {
        status: attempt < callbackMaxAttempts ? "retrying" : "failed",
        last_error: lastError,
        notified_at: attempt < callbackMaxAttempts ? null : new Date().toISOString(),
      });

      await writeUserActionLog({
        action: "resolve_job_callback_failed",
        level: "error",
        status: "error",
        details: {
          job_id: jobId,
          callback_url: job.callback.url,
          attempt_count: attempt,
          error_message: lastError,
        },
      });

      if (attempt < callbackMaxAttempts) {
        await sleep(callbackRetryDelayMs(attempt));
      }
    }
  }
}

async function postJobCallback(url, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), callbackTimeoutMs);

  try {
    return await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "user-agent": "LinkMigo-Callback/1.0",
        "x-linkmigo-event": payload.event,
        "x-linkmigo-job-id": payload.job_id,
        "x-linkmigo-job-status": payload.status,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function callbackPayload(job) {
  return {
    event: `resolve_job.${job.status}`,
    job_id: job.job_id,
    platform: job.platform,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    result: absolutizeResultUrls(job.result, job.callback?.public_base_url),
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function absolutizeResultUrls(result, publicBaseUrl) {
  if (!result || !publicBaseUrl) {
    return result;
  }

  const cloned = JSON.parse(JSON.stringify(result));

  if (Array.isArray(cloned.assets)) {
    cloned.assets = cloned.assets.map((asset) => ({
      ...asset,
      preview_url: absoluteUrl(asset.preview_url, publicBaseUrl),
      download_url: absoluteUrl(asset.download_url, publicBaseUrl),
    }));
  }

  return cloned;
}

function absoluteUrl(value, publicBaseUrl) {
  if (!value || typeof value !== "string") {
    return value;
  }

  try {
    return new URL(value, publicBaseUrl).toString();
  } catch {
    return value;
  }
}

function callbackRetryDelayMs(attempt) {
  return attempt === 1 ? 1_000 : 3_000;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function jobResultSummary(result) {
  if (result?.mode === "profile") {
    const count = Array.isArray(result.posts) ? result.posts.length : 0;

    return {
      downloadedBytes: 0,
      totalBytes: null,
      assetIndex: count,
      assetCount: count,
    };
  }

  const assets = Array.isArray(result?.assets) ? result.assets : [];
  const totalBytes = assets.reduce((sum, asset) => sum + (asset.size_bytes || 0), 0);

  return {
    downloadedBytes: totalBytes,
    totalBytes,
    assetIndex: assets.length,
    assetCount: assets.length,
  };
}
