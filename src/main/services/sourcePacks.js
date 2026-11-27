const fs = require("node:fs");
const path = require("node:path");

function loadSourcePacks() {
  const filePath = path.join(__dirname, "../data/recommendedSourcePacks.json");
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || !Array.isArray(parsed.packs)) {
    throw new Error("Source packs are invalid");
  }
  return parsed.packs.map((pack) => ({
    id: String(pack.id || "").trim(),
    title: String(pack.title || "").trim(),
    description: String(pack.description || "").trim(),
    sites: (Array.isArray(pack.sites) ? pack.sites : []).map((site) => ({
      title: String(site.title || "").trim(),
      url: String(site.url || "").trim(),
      feedUrl: String(site.feedUrl || "").trim(),
      folderPath: String(pack.title || "").trim() || "Recommended"
    }))
  })).filter((pack) => pack.id && pack.title);
}

module.exports = {
  loadSourcePacks
};
