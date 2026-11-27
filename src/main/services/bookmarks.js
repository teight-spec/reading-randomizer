const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

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
  const targetFolders = Array.isArray(options.targetFolders)
    ? options.targetFolders.map((name) => String(name || "").trim()).filter(Boolean)
    : [];
  const raw = await fs.readFile(bookmarksPath, "utf8");
  const bookmarks = JSON.parse(raw);
  const targets = new Set(targetFolders.map((name) => name.toLowerCase()));
  const foundFolders = [];
  const sites = [];

  if (targets.size) {
    for (const root of Object.values(bookmarks.roots || {})) {
      if (root && typeof root === "object") {
        walkBookmarkNode(root, [], false, targets, foundFolders, sites);
      }
    }
  }

  return {
    bookmarksPath,
    targetFolders,
    foundFolders,
    sites: dedupeSites(sites)
  };
}

async function listChromeBookmarkFolders(options = {}) {
  const bookmarksPath = options.bookmarksPath || getDefaultChromeBookmarksPath();
  try {
    const raw = await fs.readFile(bookmarksPath, "utf8");
    const bookmarks = JSON.parse(raw);
    const folders = [];
    for (const root of Object.values(bookmarks.roots || {})) {
      if (root && typeof root === "object" && root.type === "folder") {
        const tree = buildFolderTree(root, []);
        if (tree) folders.push(tree);
      }
    }
    return {
      available: true,
      bookmarksPath,
      folders
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        available: false,
        bookmarksPath,
        folders: [],
        message: "没有检测到 Chrome 书签。可以先跳过，之后再从设置里导入。"
      };
    }
    throw error;
  }
}

function walkBookmarkNode(node, folderPath, insideTargetFolder, targetNames, foundFolders, sites) {
  const nodeType = node.type;
  const nodeName = node.name || "";
  const nextPath = nodeName ? [...folderPath, nodeName] : folderPath;
  const pathKey = nextPath.join("/").toLowerCase();
  const isTargetFolder = nodeType === "folder" && (
    targetNames.has(pathKey) ||
    targetNames.has(nodeName.toLowerCase())
  );
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

function buildFolderTree(node, folderPath) {
  if (!node || node.type !== "folder") return null;
  const nodeName = node.name || "";
  const nextPath = nodeName ? [...folderPath, nodeName] : folderPath;
  const children = [];
  const directUrls = [];
  for (const child of node.children || []) {
    if (child?.type === "folder") {
      const nested = buildFolderTree(child, nextPath);
      if (nested) children.push(nested);
    } else if (child?.type === "url" && child.url) {
      directUrls.push(child.url);
    }
  }
  const urls = new Set(directUrls.map(normalizeBookmarkUrl).filter(Boolean));
  for (const child of children) {
    for (const url of child.urls || []) urls.add(url);
  }
  return {
    name: nodeName || nextPath.join("/"),
    path: nextPath.join("/"),
    urlCount: urls.size,
    urls: [...urls],
    children
  };
}

function normalizeBookmarkUrl(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
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
  getDefaultChromeBookmarksPath,
  listChromeBookmarkFolders,
  readChromeBookmarks
};
