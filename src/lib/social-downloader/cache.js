import fs from "node:fs/promises";
import path from "node:path";

import { AppError, ErrorCode } from "./errors";

export class CacheStore {
  constructor(root, ttlSeconds, maxBytes) {
    this.root = root;
    this.ttlSeconds = ttlSeconds;
    this.maxBytes = maxBytes;
  }

  async ensureRoot() {
    await fs.mkdir(this.root, { recursive: true });
  }

  recordDir(requestId, platform = "") {
    return platform
      ? path.join(this.root, platformDirName(platform), requestId)
      : path.join(this.root, requestId);
  }

  metadataPath(requestId, platform = "") {
    return path.join(this.recordDir(requestId, platform), "metadata.json");
  }

  async getRecord(requestId) {
    const metadataPath = await this.findMetadataPath(requestId);

    if (!metadataPath) {
      throw new AppError(ErrorCode.CACHE_EXPIRED, "缓存不存在或已过期。", 404);
    }

    const record = await this.readRecord(metadataPath);

    if (isExpired(record)) {
      throw new AppError(ErrorCode.CACHE_EXPIRED, "缓存已过期，请重新解析链接。", 410);
    }

    return record;
  }

  async findByCanonical(canonicalUrl) {
    let matchedRecord = null;

    for (const metadataPath of await this.metadataPaths()) {
      let record;

      try {
        record = await this.readRecord(metadataPath);
      } catch {
        continue;
      }

      if (record.canonical_url === canonicalUrl) {
        matchedRecord = fresherRecord(matchedRecord, record);
      }
    }

    return matchedRecord;
  }

  async touchRecord(record) {
    const now = new Date();
    const touched = {
      ...record,
      expires_at: new Date(now.getTime() + this.ttlSeconds * 1000).toISOString(),
    };

    await this.saveRecord(touched);

    return touched;
  }

  async saveRecord(record) {
    const recordDir = this.recordDir(record.request_id, record.platform);

    await fs.mkdir(recordDir, { recursive: true });
    await fs.writeFile(
      this.metadataPath(record.request_id, record.platform),
      JSON.stringify(record, null, 2),
      "utf8",
    );
  }

  async getAsset(record, assetId) {
    const asset = record.assets.find((item) => item.id === assetId);

    if (!asset) {
      throw new AppError(ErrorCode.NO_MEDIA_FOUND, "没有找到这个媒体资源。", 404);
    }

    return asset;
  }

  async assetPath(record, asset) {
    const recordRoot = path.resolve(this.recordDir(record.request_id, record.platform));
    const filePath = path.resolve(recordRoot, asset.relative_path);

    if (!isInside(filePath, recordRoot)) {
      throw new AppError(ErrorCode.CACHE_EXPIRED, "缓存路径无效。", 410);
    }

    try {
      await fs.access(filePath);
    } catch {
      throw new AppError(ErrorCode.CACHE_EXPIRED, "缓存文件不存在，请重新解析链接。", 410);
    }

    return filePath;
  }

  async cleanup() {
    await this.ensureRoot();
    const stats = {
      checked: 0,
      removedRecords: 0,
      removedFiles: 0,
      removedDirectories: 0,
      failed: 0,
      errors: [],
    };

    for (const metadataPath of await this.metadataPaths()) {
      stats.checked += 1;

      let record;

      try {
        record = await this.readRecord(metadataPath);
      } catch (error) {
        stats.failed += 1;
        stats.errors.push(cleanupError(metadataPath, error));
        continue;
      }

      if (!isExpired(record)) {
        continue;
      }

      try {
        const recordDir = path.dirname(metadataPath);
        const removed = await this.removeRecordDir(recordDir);

        stats.removedRecords += 1;
        stats.removedFiles += removed.files;
        stats.removedDirectories += removed.directories;
      } catch (error) {
        stats.failed += 1;
        stats.errors.push(cleanupError(metadataPath, error));
      }
    }

    return stats;
  }

  async readRecord(metadataPath) {
    return JSON.parse(await fs.readFile(metadataPath, "utf8"));
  }

  async findMetadataPath(requestId) {
    const recordDir = await this.findRecordDir(requestId);

    if (!recordDir) {
      return "";
    }

    const metadataPath = path.join(recordDir, "metadata.json");

    try {
      await fs.access(metadataPath);
      return metadataPath;
    } catch {
      return "";
    }
  }

  async findRecordDir(requestId) {
    await this.ensureRoot();

    const legacy = path.join(this.root, requestId);

    if (await exists(legacy)) {
      return legacy;
    }

    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const candidate = path.join(this.root, entry.name, requestId);

      if (await exists(candidate)) {
        return candidate;
      }
    }

    return "";
  }

  async metadataPaths() {
    await this.ensureRoot();

    const paths = [];

    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      const first = path.join(this.root, entry.name);

      if (!entry.isDirectory()) {
        continue;
      }

      const direct = path.join(first, "metadata.json");

      if (await exists(direct)) {
        paths.push(direct);
      }

      for (const child of await fs.readdir(first, { withFileTypes: true }).catch(() => [])) {
        if (!child.isDirectory()) {
          continue;
        }

        const nested = path.join(first, child.name, "metadata.json");

        if (await exists(nested)) {
          paths.push(nested);
        }
      }
    }

    return paths;
  }

  async removeRecordDir(recordDir) {
    const root = path.resolve(this.root);
    const target = path.resolve(recordDir);

    if (!isInside(target, root)) {
      throw new AppError(ErrorCode.CACHE_EXPIRED, "缓存清理路径无效。", 410);
    }

    const stats = await removeDirectoryContents(target);

    try {
      await fs.rmdir(target);
      stats.directories += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    stats.directories += await removeEmptyPlatformDir(path.dirname(target), root);

    return stats;
  }
}

export function isExpired(record) {
  return Date.now() >= new Date(record.expires_at).getTime();
}

function fresherRecord(left, right) {
  if (!left) {
    return right;
  }

  const leftTime = recordFreshnessTime(left);
  const rightTime = recordFreshnessTime(right);

  return rightTime > leftTime ? right : left;
}

function recordFreshnessTime(record) {
  return Math.max(
    Date.parse(record.expires_at) || 0,
    Date.parse(record.created_at) || 0,
  );
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isInside(filePath, parent) {
  const relative = path.relative(parent, filePath);

  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function platformDirName(platform) {
  return String(platform).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || "unknown";
}

async function removeDirectoryContents(directory) {
  const stats = { files: 0, directories: 0 };
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  });

  for (const entry of entries) {
    const childPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      const childStats = await removeDirectoryContents(childPath);

      stats.files += childStats.files;
      stats.directories += childStats.directories;

      try {
        await fs.rmdir(childPath);
        stats.directories += 1;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }

      continue;
    }

    try {
      await fs.unlink(childPath);
      stats.files += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return stats;
}

async function removeEmptyPlatformDir(directory, root) {
  const target = path.resolve(directory);

  if (target === root || !isInside(target, root)) {
    return 0;
  }

  try {
    await fs.rmdir(target);
    return 1;
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) {
      throw error;
    }
  }

  return 0;
}

function cleanupError(metadataPath, error) {
  return {
    metadata_path: metadataPath,
    message: error instanceof Error ? error.message : String(error),
  };
}
