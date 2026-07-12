const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const projectRoot = path.resolve(__dirname, "..");
const appPath = path.join(os.homedir(), "Desktop", "Reading Randomizer.app");
const contentsPath = path.join(appPath, "Contents");
const macosPath = path.join(contentsPath, "MacOS");
const resourcesPath = path.join(contentsPath, "Resources");
const executablePath = path.join(macosPath, "Reading Randomizer");
const iconSourcePath = path.join(projectRoot, "assets", "app-icon.icns");
const iconTargetPath = path.join(resourcesPath, "app-icon.icns");

async function main() {
  await fs.rm(appPath, { recursive: true, force: true });
  await fs.mkdir(macosPath, { recursive: true });
  await fs.mkdir(resourcesPath, { recursive: true });
  await fs.copyFile(iconSourcePath, iconTargetPath);
  await fs.writeFile(path.join(contentsPath, "Info.plist"), infoPlist(), "utf8");
  await fs.writeFile(executablePath, launcherScript(), "utf8");
  await fs.chmod(executablePath, 0o755);
  console.log(`Created ${appPath}`);
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Reading Randomizer</string>
  <key>CFBundleExecutable</key>
  <string>Reading Randomizer</string>
  <key>CFBundleIconFile</key>
  <string>app-icon</string>
  <key>CFBundleIdentifier</key>
  <string>com.teightspec.reading-randomizer.launcher</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Reading Randomizer</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function launcherScript() {
  return `#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "${projectRoot}" || exit 1
exec npm run start
`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
