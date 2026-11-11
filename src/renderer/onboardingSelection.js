(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) root.OnboardingSelection = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const LEGACY_ONBOARDING_FOLDER_NAMES = ["english", "fashion", "literary award"];

  function defaultSelectedFolderPaths(folders = []) {
    const names = new Set(LEGACY_ONBOARDING_FOLDER_NAMES);
    const selected = [];
    walkFolders(folders, (folder) => {
      const name = String(folder?.name || "").trim().toLowerCase();
      if (names.has(name) && folder.path) selected.push(folder.path);
    });
    return selected;
  }

  function summarizeFolderSelection(folders = [], selectedPaths = []) {
    const selected = new Set(selectedPaths);
    let folderCount = 0;
    let linkCount = 0;
    function walk(nodes, ancestorSelected) {
      for (const node of nodes || []) {
        const chosen = selected.has(node.path);
        if (chosen) folderCount += 1;
        if (chosen && !ancestorSelected) linkCount += Number(node.urlCount) || 0;
        walk(node.children, ancestorSelected || chosen);
      }
    }
    walk(folders, false);
    return { folderCount, linkCount };
  }

  function formatFolderSummary(summary) {
    const folderCount = Number(summary?.folderCount) || 0;
    const linkCount = Number(summary?.linkCount) || 0;
    return `已选 ${folderCount} 个文件夹，共 ${linkCount} 个链接`;
  }

  function countUniqueAdditions(existingUrls = [], incomingUrls = []) {
    const seen = new Set(existingUrls.map(normalizeComparableUrl).filter(Boolean));
    let added = 0;
    let duplicates = 0;
    const accepted = [];
    for (const url of incomingUrls) {
      const normalized = normalizeComparableUrl(url);
      if (!normalized) continue;
      if (seen.has(normalized)) {
        duplicates += 1;
        continue;
      }
      seen.add(normalized);
      accepted.push(normalized);
      added += 1;
    }
    return { added, duplicates, accepted };
  }

  function walkFolders(folders, visit) {
    for (const folder of folders || []) {
      visit(folder);
      walkFolders(folder.children, visit);
    }
  }

  function normalizeComparableUrl(url) {
    try {
      const parsed = new URL(String(url));
      if (!["http:", "https:"].includes(parsed.protocol)) return "";
      if (parsed.username || parsed.password) return "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return "";
    }
  }

  return {
    LEGACY_ONBOARDING_FOLDER_NAMES,
    countUniqueAdditions,
    defaultSelectedFolderPaths,
    formatFolderSummary,
    normalizeComparableUrl,
    summarizeFolderSelection
  };
});
