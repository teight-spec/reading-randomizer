const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DISPLAY_NAME = "随阅";
const projectRoot = path.resolve(__dirname, "..");
const sourceApp = path.join(projectRoot, "node_modules", "electron", "dist", "Electron.app");
const destDir = path.join(projectRoot, ".electron-runtime");
const destApp = path.join(destDir, `${DISPLAY_NAME}.app`);
const stampPath = path.join(destDir, ".bundle-stamp");

function electronVersion() {
  const packagePath = path.join(projectRoot, "node_modules", "electron", "package.json");
  return JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
}

function bundleIsCurrent() {
  if (!fs.existsSync(destApp) || !fs.existsSync(stampPath)) return false;
  try {
    return fs.readFileSync(stampPath, "utf8").trim() === electronVersion();
  } catch {
    return false;
  }
}

function setPlistString(plist, key, value) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist], { stdio: "pipe" });
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist], { stdio: "pipe" });
  }
}

async function main() {
  if (!fs.existsSync(sourceApp)) {
    throw new Error(`Official Electron.app is missing at ${sourceApp}. Run npm ci first.`);
  }

  if (!bundleIsCurrent()) {
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.rm(destApp, { recursive: true, force: true });
    await fsp.cp(sourceApp, destApp, { recursive: true, verbatimSymlinks: true });
    await fsp.writeFile(stampPath, `${electronVersion()}\n`, "utf8");
  }

  const plist = path.join(destApp, "Contents", "Info.plist");
  setPlistString(plist, "CFBundleName", DISPLAY_NAME);
  setPlistString(plist, "CFBundleDisplayName", DISPLAY_NAME);
  const macosDir = path.join(destApp, "Contents", "MacOS");
  const officialBinary = path.join(macosDir, "Electron");
  const namedBinary = path.join(macosDir, DISPLAY_NAME);
  if (fs.existsSync(officialBinary)) {
    await fsp.copyFile(officialBinary, namedBinary);
    await fsp.chmod(namedBinary, 0o755);
  }
  setPlistString(plist, "CFBundleExecutable", DISPLAY_NAME);

  const iconSource = path.join(projectRoot, "assets", "app-icon.icns");
  if (fs.existsSync(iconSource)) {
    const resources = path.join(destApp, "Contents", "Resources");
    await fsp.copyFile(iconSource, path.join(resources, "app-icon.icns"));
    const electronIcon = path.join(resources, "electron.icns");
    if (fs.existsSync(electronIcon)) {
      await fsp.copyFile(iconSource, electronIcon);
    }
    try {
      setPlistString(plist, "CFBundleIconFile", "app-icon");
    } catch {
      // Icon key is best-effort; the display name still applies.
    }
  }

  const leftoverPinyinBundle = path.join(destDir, "Suiyue.app");
  if (fs.existsSync(leftoverPinyinBundle) && path.resolve(leftoverPinyinBundle) !== path.resolve(destApp)) {
    await fsp.rm(leftoverPinyinBundle, { recursive: true, force: true });
  }

  const binary = fs.existsSync(namedBinary) ? namedBinary : officialBinary;
  if (!fs.existsSync(binary)) {
    throw new Error("Patched 随阅.app is missing the official Electron binary");
  }
  process.stdout.write(`${binary}\n`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
