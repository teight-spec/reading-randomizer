const fs = require("node:fs/promises");
const path = require("node:path");

async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // The app can still continue when an existing parent directory is not chmod-able.
  }
  try {
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  writeJsonAtomic
};
