const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const runFile = promisify(execFile);
const runInstallation = (command, args, options) =>
  new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    let failure,
      stdout = "",
      stderr = "";
    const child = execFile(command, args, options, (error, output, diagnostic) => {
      failure = error;
      stdout = output;
      stderr = diagnostic;
    });
    // The callback can report cancellation before close. Staging remains owned
    // until the R process and its stdio have actually closed.
    child.once("close", () => {
      if (options.signal?.aborted) reject(options.signal.reason);
      else if (failure) reject(failure);
      else resolve({ stdout, stderr });
    });
  });

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

exports.resolveRuntime = async (context, configuredPath, env = process.env) =>
  context.resolver.select({
    configuredPath,
    kind: "executable",
    candidates: () => [
      ...context.resolver.findExecutables("Rscript", { env, cwd: context.rootPath }),
      ...exports.runtimeCandidates(env),
    ],
    cwd: context.rootPath,
    signal: context.signal,
  });

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

exports.resolveServer = async (context, { serverPath = "", libraryPath = "" } = {}) => {
  const runtime = await exports.resolveRuntime(context, serverPath);
  if (!runtime) return null;
  const command = runtime.path;
  let managedModule;
  const library = await context.resolver.select({
    configuredPath: libraryPath,
    managed: () => {
      const installed = context.getManagedServer();
      if (!installed) return null;
      managedModule = installed.modulePath;
      return {
        path: path.dirname(path.dirname(managedModule)),
        version: installed.version,
      };
    },
    kind: "directory",
    signal: context.signal,
    async validate(_directory, { source, signal }) {
      if (source === "managed")
        await context.resolver.validateFile(managedModule, {
          kind: "file",
          label: "Managed languageserver package",
          signal,
        });
    },
  });
  const env = exports.libraryEnvironment(library?.path || "");
  try {
    const { stdout } = await runFile(
      command,
      [
        "--vanilla",
        "-e",
        "if (!requireNamespace('languageserver', quietly=TRUE)) quit(status=20L); cat(as.character(utils::packageVersion('languageserver')))",
      ],
      {
        env: { ...process.env, ...env },
        cwd: context.rootPath,
        signal: context.signal,
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 256 * 1024,
      },
    );
    const version = stdout.trim();
    if (!/^\d+(?:\.\d+)+$/.test(version))
      throw new Error("Rscript did not report a languageserver package version.");
    return context.resolver.launch(runtime, {
      signal: context.signal,
      args: ["--no-save", "--no-restore", "-e", "languageserver::run()"],
      env,
      version,
      cwd: context.rootPath,
      transport: "stdio",
    });
  } catch (error) {
    context.signal?.throwIfAborted();
    if (error.code === 20) return null;
    throw new Error(`Could not start Rscript: ${String(error.stderr || error.message).trim()}`, {
      cause: error,
    });
  }
};

exports.installServer = async (
  { storagePath, api, signal = api.signal },
  { serverPath = "", cranMirror = "https://cloud.r-project.org", downloadMethod = "auto" } = {},
) => {
  signal = api.signal || signal;
  signal?.throwIfAborted();
  const runtime = await exports.resolveRuntime({ resolver: api.resolver, signal }, serverPath);
  signal?.throwIfAborted();
  if (!runtime)
    throw new Error("Install R first and select its Rscript executable in the ide-r settings.");
  const url = new URL(cranMirror);
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("CRAN Mirror must be an HTTP or HTTPS URL.");
  const library = path.join(storagePath, "library");
  await fs.promises.mkdir(library, { recursive: true });
  signal?.throwIfAborted();
  api.setServerInstallationStatus("installing");
  if (!["auto", "libcurl", "curl"].includes(downloadMethod))
    throw new Error("Unknown R download method.");
  const expression = `options(download.file.method=${JSON.stringify(downloadMethod)}); .libPaths(c(${JSON.stringify(library)}, .libPaths())); utils::install.packages("languageserver", lib=${JSON.stringify(library)}, repos=${JSON.stringify(cranMirror)}); if (!requireNamespace("languageserver", lib.loc=${JSON.stringify(library)}, quietly=TRUE)) stop("The languageserver package did not install successfully"); cat("LUMINE_SERVER_VERSION=", as.character(utils::packageVersion("languageserver", lib.loc=${JSON.stringify(library)})), "\\n", sep="")`;
  signal?.throwIfAborted();
  const { stdout } = await runInstallation(runtime.path, ["--vanilla", "-e", expression], {
    env: { ...process.env, ...exports.libraryEnvironment("") },
    windowsHide: true,
    timeout: 600000,
    maxBuffer: 4 * 1024 * 1024,
    signal,
  });
  signal?.throwIfAborted();
  const version = /^LUMINE_SERVER_VERSION=(\S+)$/m.exec(stdout)?.[1];
  if (!version) throw new Error("R installed languageserver without reporting its version.");
  return { version, module: path.join("library", "languageserver", "DESCRIPTION") };
};

exports.latestServerVersion = async (
  context,
  { serverPath = "", cranMirror = "https://cloud.r-project.org", downloadMethod = "auto" } = {},
) => {
  context.signal?.throwIfAborted();
  const runtime = await exports.resolveRuntime(context, serverPath);
  context.signal?.throwIfAborted();
  if (!runtime) return null;
  if (!["auto", "libcurl", "curl"].includes(downloadMethod))
    throw new Error("Unknown R download method.");
  const expression = `options(download.file.method=${JSON.stringify(downloadMethod)}); packages <- utils::available.packages(repos=${JSON.stringify(cranMirror)}); if ("languageserver" %in% rownames(packages)) cat(packages["languageserver", "Version"])`;
  const { stdout } = await runFile(runtime.path, ["--vanilla", "-e", expression], {
    env: { ...process.env, ...exports.libraryEnvironment("") },
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 256 * 1024,
    signal: context.signal,
  });
  context.signal?.throwIfAborted();
  return stdout.trim() || null;
};
