import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const defaultCacheDir = path.join(".cache", "social-downloader");
const configuredCacheDir =
  process.env.SOCIAL_CACHE_DIR?.trim() ||
  process.env.IG_CACHE_DIR?.trim() ||
  defaultCacheDir;
const cacheRoot = path.resolve(projectRoot, configuredCacheDir);
const isDryRun = process.argv.includes("--dry-run");

await assertSafeCacheRoot(cacheRoot);

const entries = await fs.readdir(cacheRoot, { withFileTypes: true }).catch((error) => {
  if (error?.code === "ENOENT") {
    return [];
  }

  throw error;
});

if (isDryRun) {
  console.log(`[dry-run] Cache root: ${cacheRoot}`);
  console.log(`[dry-run] Entries to remove: ${entries.length}`);
  process.exit(0);
}

let removed = 0;

for (const entry of entries) {
  await fs.rm(path.join(cacheRoot, entry.name), {
    force: true,
    recursive: true,
  });
  removed += 1;
}

await fs.mkdir(cacheRoot, { recursive: true });

console.log(`Cleared social downloader cache: ${cacheRoot}`);
console.log(`Removed entries: ${removed}`);

async function assertSafeCacheRoot(target) {
  const root = path.parse(target).root;

  if (target === root || target === projectRoot || target === path.dirname(projectRoot)) {
    throw new Error(`Refusing to clear unsafe cache path: ${target}`);
  }

  const relative = path.relative(projectRoot, target);
  const isInsideProject = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  const basename = path.basename(target).toLowerCase();

  if (!isInsideProject && !basename.includes("cache")) {
    throw new Error(`Refusing to clear cache path outside project without "cache" in its name: ${target}`);
  }
}
