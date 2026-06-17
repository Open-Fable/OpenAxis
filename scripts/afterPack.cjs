// electron-builder afterPack hook — ad-hoc sign the .app bundle.
//
// `identity: null` tells electron-builder to skip signing entirely, which leaves
// the bundle without a _CodeSignature/CodeResources seal.  macOS Gatekeeper
// checks that seal on first launch; without it the verification fails mid-way
// and the app crash-loops.
//
// This hook runs after the .app is assembled but BEFORE it is packaged into
// .dmg / .zip, so the distributed artifacts contain a properly signed bundle.
const { execSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (process.platform !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  const entitlements = path.join(__dirname, "..", "build", "entitlements.mac.plist");
  console.log(`[afterPack] Ad-hoc signing ${appPath} (hardened runtime) …`);
  execSync(
    `codesign --force --deep --sign - --options runtime --entitlements '${entitlements.replace(/'/g, "'\\''")}' '${appPath.replace(/'/g, "'\\''")}'`,
    { stdio: "inherit" },
  );

  console.log("[afterPack] Verifying …");
  execSync(
    `codesign --verify --deep --verbose=2 '${appPath.replace(/'/g, "'\\''")}'`,
    { stdio: "inherit" },
  );
  console.log("[afterPack] ✓ Bundle passes deep verification");
};
