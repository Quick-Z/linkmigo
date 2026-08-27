import crypto from "node:crypto";

import { ErrorCode, toAppError } from "./errors";
import { getProfileZipFile } from "./service";
import { writeUserActionLog } from "../user-action-logger";

const profileDownloadJobsKey = "__linkmigoProfileDownloadJobs";
const jobTtlMs = 30 * 60 * 1000;

export function startProfileDownloadJob(requestId, options = {}) {
  cleanupProfileDownloadJobs();

  const postIds = normalizePostIds(options.postIds);
  const downloadOptions = normalizeProfileDownloadOptions(options);
  const now = new Date().toISOString();
  const job = {
    job_id: crypto.randomUUID().replaceAll("-", ""),
    request_id: requestId,
    download_options: {
      includeMedia: downloadOptions.includeMedia,
      includePostText: downloadOptions.includePostText,
      includeComments: downloadOptions.includeComments,
      commentLimit: downloadOptions.commentLimit,
    },
    status: "queued",
    phase: "queued",
    progress: {
      total_count: postIds.length,
      completed_count: 0,
      success_count: 0,
      partial_failed_count: 0,
      failed_count: 0,
    },
    post_statuses: Object.fromEntries(
      postIds.map((postId) => [
        postId,
        {
          post_id: postId,
          status: "queued",
          message: "等待下载",
          updated_at: now,
        },
      ]),
    ),
    result: null,
    error: null,
    created_at: now,
    updated_at: now,
  };

  getProfileDownloadJobStore().set(job.job_id, job);
  queueMicrotask(() => {
    runProfileDownloadJob(job.job_id, requestId, postIds, downloadOptions);
  });

  return snapshotProfileDownloadJob(job);
}

export function getProfileDownloadJob(jobId) {
  cleanupProfileDownloadJobs();

  if (!jobId || typeof jobId !== "string") {
    return null;
  }

  const job = getProfileDownloadJobStore().get(jobId);

  return job ? snapshotProfileDownloadJob(job) : null;
}

export function getProfileDownloadJobFile(jobId, requestId) {
  cleanupProfileDownloadJobs();

  const job = getProfileDownloadJobStore().get(jobId);

  if (!job || job.request_id !== requestId || job.status !== "completed" || !job.result?.file_path) {
    return null;
  }

  return {
    filePath: job.result.file_path,
    filename: job.result.filename,
  };
}

async function runProfileDownloadJob(jobId, requestId, postIds, downloadOptions) {
  updateProfileDownloadJob(jobId, {
    status: "running",
    phase: "downloading",
  });

  try {
    const { filePath, filename, posts } = await getProfileZipFile(requestId, {
      postIds,
      ...downloadOptions,
      onPostProgress: (event) => updatePostStatus(jobId, event),
    });

    const job = ensureCompletedPostStatuses(jobId, posts);

    updateProfileDownloadJob(jobId, {
      status: "completed",
      phase: "completed",
      progress: summarizePostStatuses(job?.post_statuses, postIds.length),
      result: {
        filename,
        file_path: filePath,
        download_url: `/api/v1/instagram/profile-requests/${encodeURIComponent(requestId)}/download-jobs/${encodeURIComponent(jobId)}/download.zip`,
      },
      error: null,
    });
  } catch (error) {
    const appError = toAppError(error);

    await writeUserActionLog({
      action: "profile_download_job_failed",
      level: "error",
      status: "error",
      details: {
        request_id: requestId,
        job_id: jobId,
        selected_post_ids: postIds,
        download_options: downloadOptions,
        error_code: appError.code,
        error_message: appError.message,
        error_status: appError.status,
        error_details: appError.details,
      },
    });

    updateProfileDownloadJob(jobId, {
      status: "failed",
      phase: "failed",
      progress: summarizePostStatuses(getProfileDownloadJobStore().get(jobId)?.post_statuses, postIds.length),
      error: {
        code: appError.code ?? ErrorCode.INTERNAL_SERVER_ERROR,
        message: appError.message || "批量下载失败，请稍后再试。",
        details: appError.details,
      },
    });
  }
}

function ensureCompletedPostStatuses(jobId, posts) {
  const job = getProfileDownloadJobStore().get(jobId);

  if (!job) {
    return null;
  }

  const now = new Date().toISOString();
  const nextPostStatuses = { ...job.post_statuses };

  for (const post of Array.isArray(posts) ? posts : []) {
    if (!post?.id) {
      continue;
    }

    const current = nextPostStatuses[post.id];

    if (["success", "partial_failed", "failed"].includes(current?.status)) {
      continue;
    }

    nextPostStatuses[post.id] = {
      post_id: post.id,
      status: "success",
      message: "下载成功",
      updated_at: now,
    };
  }

  return updateProfileDownloadJob(jobId, {
    post_statuses: nextPostStatuses,
    progress: summarizePostStatuses(nextPostStatuses, job.progress?.total_count),
  });
}

function updatePostStatus(jobId, event) {
  const job = getProfileDownloadJobStore().get(jobId);

  if (!job || !event?.post_id) {
    return;
  }

  const now = new Date().toISOString();
  const nextPostStatuses = {
    ...job.post_statuses,
    [event.post_id]: {
      post_id: event.post_id,
      status: normalizePostStatus(event.status),
      message: event.message || statusMessage(event.status),
      asset_count: numberOrNull(event.asset_count),
      expected_asset_count: numberOrNull(event.expected_asset_count),
      error: event.error ?? null,
      updated_at: now,
    },
  };

  updateProfileDownloadJob(jobId, {
    status: "running",
    phase: "downloading",
    post_statuses: nextPostStatuses,
    progress: summarizePostStatuses(nextPostStatuses, job.progress?.total_count),
  });
}

function updateProfileDownloadJob(jobId, patch) {
  const store = getProfileDownloadJobStore();
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

function summarizePostStatuses(postStatuses = {}, fallbackTotal = 0) {
  const statuses = Object.values(postStatuses || {});
  const successCount = statuses.filter((item) => item.status === "success").length;
  const partialFailedCount = statuses.filter((item) => item.status === "partial_failed").length;
  const failedCount = statuses.filter((item) => item.status === "failed").length;

  return {
    total_count: Math.max(Number(fallbackTotal) || 0, statuses.length),
    completed_count: successCount + partialFailedCount + failedCount,
    success_count: successCount,
    partial_failed_count: partialFailedCount,
    failed_count: failedCount,
  };
}

function snapshotProfileDownloadJob(job) {
  const snapshot = JSON.parse(JSON.stringify(job));

  if (snapshot.result) {
    delete snapshot.result.file_path;
  }

  return snapshot;
}

function cleanupProfileDownloadJobs() {
  const now = Date.now();

  for (const [jobId, job] of getProfileDownloadJobStore()) {
    const updatedAt = Date.parse(job?.updated_at || job?.created_at || "");

    if (!Number.isFinite(updatedAt) || now - updatedAt > jobTtlMs) {
      getProfileDownloadJobStore().delete(jobId);
    }
  }
}

function getProfileDownloadJobStore() {
  if (!globalThis[profileDownloadJobsKey]) {
    globalThis[profileDownloadJobsKey] = new Map();
  }

  return globalThis[profileDownloadJobsKey];
}

function normalizePostIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeProfileDownloadOptions(options = {}) {
  const parsedCommentLimit = Number.parseInt(String(options.commentLimit ?? ""), 10);

  return {
    includeMedia: options.includeMedia !== false,
    includePostText: options.includePostText === true,
    includeComments: options.includeComments === true,
    commentLimit: Number.isFinite(parsedCommentLimit) ? Math.min(100, Math.max(1, parsedCommentLimit)) : 20,
    sessionId: String(options.sessionId || "").trim(),
  };
}

function normalizePostStatus(value) {
  return ["queued", "downloading", "success", "partial_failed", "failed"].includes(value)
    ? value
    : "downloading";
}

function statusMessage(status) {
  if (status === "success") {
    return "下载成功";
  }

  if (status === "partial_failed") {
    return "部分资源失败";
  }

  if (status === "failed") {
    return "整帖下载失败";
  }

  return "正在下载";
}

function numberOrNull(value) {
  const number = Number(value);

  return Number.isFinite(number) && number >= 0 ? number : null;
}
