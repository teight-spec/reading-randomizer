module.exports = function registerEnsureSuiyueElectronBundleTests({ test, fs, path, assert, os }) {
  const {
    main,
    shouldSkipMissingOfficialBundle
  } = require("./ensure-suiyue-electron-bundle");

  test("CI skips the 随阅.app wrapper when the official Electron.app is missing", async () => {
    const missingApp = path.join(os.tmpdir(), "missing-official-Electron.app");
    assert.equal(shouldSkipMissingOfficialBundle({ ci: "true", sourceExists: false }), true);
    const result = await main({ sourceAppPath: missingApp, ci: "true" });
    assert.deepEqual(result, { skipped: true, reason: "missing-official-app-in-ci" });
  });

  test("non-CI still errors when the official Electron.app is missing", async () => {
    const missingApp = path.join(os.tmpdir(), "missing-official-Electron.app");
    assert.equal(shouldSkipMissingOfficialBundle({ ci: "", sourceExists: false }), false);
    assert.equal(shouldSkipMissingOfficialBundle({ ci: "0", sourceExists: false }), false);
    assert.equal(shouldSkipMissingOfficialBundle({ ci: "false", sourceExists: false }), false);
    await assert.rejects(
      () => main({ sourceAppPath: missingApp, ci: "" }),
      (error) => {
        assert.match(error.message, /Official Electron\.app is missing/);
        assert.match(error.message, /Run npm ci first/);
        return true;
      }
    );
  });
};
