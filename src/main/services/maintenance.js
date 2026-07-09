const fs = require("node:fs/promises");
const path = require("node:path");

const CACHE_DIRS = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache"
];

async function getCacheUsage(userDataPath) {
  const entries = await Promise.all(CACHE_DIRS.map(async (name) => ({
    name,
    path: path.join(userDataPath, name),
    bytes: await directorySize(path.join(userDataPath, name))
  })));
  return {
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries
  };
}

async function clearBrowserCaches({ userDataPath, session }) {
  const before = await getCacheUsage(userDataPath);
  if (session?.clearCache) {
    await session.clearCache();
  }
  await Promise.all(CACHE_DIRS.map((name) => fs.rm(path.join(userDataPath, name), {
    recursive: true,
    force: true
  })));
  const after = await getCacheUsage(userDataPath);
  return {
    before,
    after,
    freedBytes: Math.max(0, before.totalBytes - after.totalBytes)
  };
}

async function directorySize(targetPath) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(targetPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(fullPath);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(fullPath)).size;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return total;
}

module.exports = {
  CACHE_DIRS,
  clearBrowserCaches,
  getCacheUsage
};
