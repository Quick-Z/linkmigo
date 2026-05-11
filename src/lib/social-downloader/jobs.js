import crypto from "node:crypto";

import { ErrorCode, toAppError } from "./errors";
import { resolveUrl } from "./service";

const resolveJobsKey = "__linkmigoSocialResolveJobs";
const jobTtlMs = 30 * 60 * 1000;

export function startResolveJob(url) {
  cleanupJobs();

  const now = new Date().toISOString();
  const job = {
    job_id: crypto.randomUUID().replaceAll("-", ""),
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
    created_at: now,
    updated_at: now,
  };

  getJobStore().set(job.job_id, job);
  queueMicrotask(() => runResolveJob(job.job_id, url));

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

    updateJob(jobId, {
      status: "completed",
      phase: "completed",
      progress: {
        mode: "percent",
        phase: "completed",
        percent: 100,
        downloaded_bytes: result.assets.reduce((sum, asset) => sum + (asset.size_bytes || 0), 0),
        total_bytes: result.assets.reduce((sum, asset) => sum + (asset.size_bytes || 0), 0),
        asset_index: result.assets.length,
        asset_count: result.assets.length,
      },
      result,
      error: null,
    });
  } catch (error) {
    const appError = toAppError(error);

    updateJob(jobId, {
      status: "failed",
      phase: "failed",
      error: {
        code: appError.code ?? ErrorCode.INTERNAL_SERVER_ERROR,
        message: appError.message || "服务暂时不可用，请稍后再试。",
        details: appError.details,
      },
    });
  }
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

function cleanupJobs() {
  const store = getJobStore();
  const now = Date.now();

  for (const [jobId, job] of store) {
    if (now - Date.parse(job.updated_at || job.created_at || 0) > jobTtlMs) {
      store.delete(jobId);
    }
  }
}

function positiveNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? number : null;
}
