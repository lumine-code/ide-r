const childProcess = require("node:child_process");

// A runner may provide R without the separately installed languageserver package.
// Probe only that prerequisite; a server that starts and then fails still fails its specs.
exports.resolveLiveRuntime = (env = process.env) => {
  const server = require("../../lib/server");
  const runtime = env.R_LSP_PATH || server.findOnPath("Rscript", env);
  const missing = () => {
    if (env.REQUIRE_R_LSP || env.REQUIRE_R_MANAGED_INSTALL)
      throw new Error("CI requires Rscript and the real R languageserver package.");
    return null;
  };
  if (!runtime) return missing();

  const result = childProcess.spawnSync(
    runtime,
    ["--vanilla", "-e", "if (!requireNamespace('languageserver', quietly=TRUE)) quit(status=20L)"],
    {
      env: { ...env, ...server.libraryEnvironment(env.R_LSP_LIBRARY || "", env) },
      windowsHide: true,
      timeout: 20000,
      encoding: "utf8",
    },
  );
  if (result.status === 20) return missing();
  if (result.error || result.status !== 0)
    throw new Error(
      `Could not check the real R server: ${result.error?.message || result.stderr?.trim() || `Rscript exited with status ${result.status}`}`,
    );
  return runtime;
};
