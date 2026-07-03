import crypto from "node:crypto";

import { ErrorCode, toAppError } from "./errors";
import { getSocialDownloaderSettings } from "./settings";
import { resolveUrl } from "./service";
import { normalizeSocialUrl } from "./social";
import { writeUserActionLog } from "../user-action-logger";

const resolveJobsKey = "__linkmigoSocialResolveJobs";
const resolveSchedulerKey = "__linkmigoSocialResolveScheduler";
const jobTtlMs = 30 * 60 * 1000;

export function startResolveJob(url) {
  cleanupJobs();

  const now = new Date().toISOString();
  const platform = resolveJobPlatform(url);
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
    queue_position: null,
    created_at: now,
    updated_at: now,
  };

  getJobStore().set(job.job_id, job);
  enqueueResolveJob(job.job_id, url, platform);

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

async function runResolveJob(jobId, url) {
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
  }
}

function enqueueResolveJob(jobId, url, platform) {
  const scheduler = getScheduler();

  scheduler.pending.push({ jobId, url, platform });
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
    runResolveJob(next.jobId, next.url).finally(() => {
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

function snapshotJob(job) {
  return JSON.parse(JSON.stringify(job));
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
