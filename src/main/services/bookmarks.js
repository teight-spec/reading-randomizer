const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_TARGET_FOLDERS = ["English", "fashion", "literary award"];

function getDefaultChromeBookmarksPath() {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "Default",
      "Bookmarks"
    );
  }

  if (process.platform === "win32") {
    return path.join(
      os.homedir(),
      "AppData",
      "Local",
      "Google",
      "Chrome",
      "User Data",
      "Default",
      "Bookmarks"
    );
  }

  return path.join(os.homedir(), ".config", "google-chrome", "Default", "Bookmarks");
}

async function readChromeBookmarks(options = {}) {
  const bookmarksPath = options.bookmarksPath || getDefaultChromeBookmarksPath();
  const targetFolders = options.targetFolders || DEFAULT_TARGET_FOLDERS;
  const raw = await fs.readFile(bookmarksPath, "utf8");
  const bookmarks = JSON.parse(raw);
  const targetNames = new Set(targetFolders.map((name) => name.toLowerCase()));
  const foundFolders = [];
  const sites = [];

  for (const root of Object.values(bookmarks.roots || {})) {
    if (root && typeof root === "object") {
      walkBookmarkNode(root, [], false, targetNames, foundFolders, sites);
    }
  }

  return {
    bookmarksPath,
    targetFolders,
    foundFolders,
    sites: dedupeSites(sites)
  };
}

function walkBookmarkNode(node, folderPath, insideTargetFolder, targetNames, foundFolders, sites) {
  const nodeType = node.type;
  const nodeName = node.name || "";
  const nextPath = nodeName ? [...folderPath, nodeName] : folderPath;
  const isTargetFolder = nodeType === "folder" && targetNames.has(nodeName.toLowerCase());
  const shouldCollect = insideTargetFolder || isTargetFolder;

  if (isTargetFolder) {
    foundFolders.push(nextPath.join("/"));
  }

  if (nodeType === "url" && shouldCollect && node.url) {
    sites.push({
      id: stableSiteId(node.url),
      title: nodeName || node.url,
      url: node.url,
      domain: getDomain(node.url),
      folderPath: folderPath.join("/")
    });
  }

  for (const child of node.children || []) {
    walkBookmarkNode(child, nextPath, shouldCollect, targetNames, foundFolders, sites);
  }
}

function dedupeSites(sites) {
  const byUrl = new Map();
  for (const site of sites) {
    if (!byUrl.has(site.url)) {
      byUrl.set(site.url, site);
    }
  }
  return [...byUrl.values()];
}

function stableSiteId(url) {
  return Buffer.from(url).toString("base64url");
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

module.exports = {
  DEFAULT_TARGET_FOLDERS,
  getDefaultChromeBookmarksPath,
  readChromeBookmarks
};
