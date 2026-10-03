const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const runFile = promisify(execFile);

exports.findOnPath = (name, env = process.env) => {
  const extensions = process.platform === "win32" ? ["", ".exe"] : [""];
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      try {
        if (fs.statSync(candidate).isFile()) {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch {
        // Continue through PATH.
      }
    }
  }
  return null;
};

exports.runtimeCandidates = (env = process.env, platform = process.platform) => {
  const candidates = [];
  if (env.R_HOME) {
    candidates.push(path.join(env.R_HOME, "bin", platform === "win32" ? "Rscript.exe" : "Rscript"));
    if (platform === "win32") candidates.push(path.join(env.R_HOME, "bin", "x64", "Rscript.exe"));
  }
  if (platform === "darwin")
    candidates.push("/Library/Frameworks/R.framework/Resources/bin/Rscript");
  if (platform === "win32") {
    for (const parent of [
      env.ProgramFiles,
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs"),
    ].filter(Boolean)) {
      const directory = path.join(parent, "R");
      try {
        const versions = fs
          .readdirSync(directory)
          .filter((name) => /^R-\d/.test(name))
          .sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
        for (const version of versions) {
          candidates.push(path.join(directory, version, "bin", "Rscript.exe"));
          candidates.push(path.join(directory, version, "bin", "x64", "Rscript.exe"));
        }
      } catch {
        // R may be installed elsewhere; Server Path covers that case.
      }
    }
  }
  return candidates;
};

exports.resolveRuntime = async (configuredPath, env = process.env) => {
  if (configuredPath) {
    if (!(await fs.promises.stat(configuredPath)).isFile())
      throw new Error("Rscript Path must name an executable file.");
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(configuredPath))
      throw new Error("Rscript Path must name the native Rscript executable.");
    await fs.promises.access(configuredPath, fs.constants.X_OK);
    return configuredPath;
  }
  const onPath = exports.findOnPath("Rscript", env);
  if (onPath) return onPath;
  for (const candidate of exports.runtimeCandidates(env)) {
    try {
      if (!(await fs.promises.stat(candidate)).isFile()) continue;
      await fs.promises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next installed R version.
    }
  }
  return null;
};

exports.libraryEnvironment = (libraryPath, env = process.env, platform = process.platform) => {
  const overrides = libraryPath
    ? { R_LIBS: [libraryPath, env.R_LIBS].filter(Boolean).join(path.delimiter) }
    : {};
  if (platform === "win32") {
    // POSIX shells often export C.UTF-8. Native Windows R rejects that locale
    // and parses emoji as <U+...> escapes, corrupting rename/reference ranges.
    // An empty override restores R's native UTF-8 locale, also for callr workers.
    for (const key of [
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "LC_COLLATE",
      "LC_MONETARY",
      "LC_TIME",
      "LC_NUMERIC",
      "LC_MESSAGES",
    ]) {
      if (/^C[._-]UTF-?8$/i.test(env[key] || "")) overrides[key] = "";
    }
  }
  return overrides;
};

exports.resolveServer = async (configuredPath, libraryPath = "", managed = null) => {
  const command = await exports.resolveRuntime(configuredPath);
  if (!command) return null;
  const library =
    libraryPath || (managed?.modulePath && path.dirname(path.dirname(managed.modulePath))) || "";
  const env = exports.libraryEnvironment(library);
  try {
    const { stdout } = await runFile(
      command,
      [
        "--vanilla",
        "-e",
        "if (!requireNamespace('languageserver', quietly=TRUE)) quit(status=20L); cat(as.character(utils::packageVersion('languageserver')))",
      ],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024 },
    );
    const version = stdout.trim();
    if (!/^\d+(?:\.\d+)+$/.test(version))
      throw new Error("Rscript did not report a languageserver package version.");
    return {
      command,
      args: ["--no-save", "--no-restore", "-e", "languageserver::run()"],
      env,
      version,
    };
  } catch (error) {
    if (error.code === 20) return null;
    throw new Error(`Could not start Rscript: ${String(error.stderr || error.message).trim()}`, {
      cause: error,
    });
  }
};

exports.installServer = async (
  { storagePath, api },
  { serverPath = "", cranMirror = "https://cloud.r-project.org", downloadMethod = "auto" } = {},
) => {
  const command = await exports.resolveRuntime(serverPath);
  if (!command)
    throw new Error("Install R first and select its Rscript executable in the ide-r settings.");
  const url = new URL(cranMirror);
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("CRAN Mirror must be an HTTP or HTTPS URL.");
  const library = path.join(storagePath, "library");
  await fs.promises.mkdir(library, { recursive: true });
  api.setServerInstallationStatus("installing");
  if (!["auto", "libcurl", "curl"].includes(downloadMethod))
    throw new Error("Unknown R download method.");
  const expression = `options(download.file.method=${JSON.stringify(downloadMethod)}); .libPaths(c(${JSON.stringify(library)}, .libPaths())); utils::install.packages("languageserver", lib=${JSON.stringify(library)}, repos=${JSON.stringify(cranMirror)}); if (!requireNamespace("languageserver", lib.loc=${JSON.stringify(library)}, quietly=TRUE)) stop("The languageserver package did not install successfully"); cat("LUMINE_SERVER_VERSION=", as.character(utils::packageVersion("languageserver", lib.loc=${JSON.stringify(library)})), "\\n", sep="")`;
  const { stdout } = await runFile(command, ["--vanilla", "-e", expression], {
    env: { ...process.env, ...exports.libraryEnvironment("") },
    windowsHide: true,
    timeout: 600000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const version = /^LUMINE_SERVER_VERSION=(\S+)$/m.exec(stdout)?.[1];
  if (!version) throw new Error("R installed languageserver without reporting its version.");
  return { version, module: path.join("library", "languageserver", "DESCRIPTION") };
};

exports.latestServerVersion = async ({
  serverPath = "",
  cranMirror = "https://cloud.r-project.org",
  downloadMethod = "auto",
} = {}) => {
  const command = await exports.resolveRuntime(serverPath);
  if (!command) return null;
  if (!["auto", "libcurl", "curl"].includes(downloadMethod))
    throw new Error("Unknown R download method.");
  const expression = `options(download.file.method=${JSON.stringify(downloadMethod)}); packages <- utils::available.packages(repos=${JSON.stringify(cranMirror)}); if ("languageserver" %in% rownames(packages)) cat(packages["languageserver", "Version"])`;
  const { stdout } = await runFile(command, ["--vanilla", "-e", expression], {
    env: { ...process.env, ...exports.libraryEnvironment("") },
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 256 * 1024,
  });
  return stdout.trim() || null;
};
