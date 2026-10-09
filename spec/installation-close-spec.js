const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { promisify } = require("node:util");

describe("R installation process retirement", () => {
  let server, directory, child, complete;
  beforeEach(async () => {
    await lumine.packages.deactivatePackage("ide-r");
    if (lumine.packages.isPackageLoaded("ide-r")) await lumine.packages.unloadPackage("ide-r");
    child = new EventEmitter();
    const execute = spyOn(childProcess, "execFile").and.callFake(
      (_command, _args, _options, callback) => {
        complete = callback;
        return child;
      },
    );
    // Preserve Node's custom promisify contract on this controlled boundary so
    // the original implementation and the close-owned one see the same API.
    execute[promisify.custom] = (...args) =>
      new Promise((resolve, reject) =>
        execute(...args, (error, stdout, stderr) => {
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
          } else resolve({ stdout, stderr });
        }),
      );
    await lumine.packages.activatePackage("ide-r");
    server = require("../lib/server");
    spyOn(server, "resolveRuntime").and.resolveTo({ path: "controlled-rscript" });
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "r-install-close-")));
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-r");
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), directory);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Unsafe R fixture cleanup");
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  it("keeps the staging operation pending until a cancelled process closes", async () => {
    const controller = new AbortController();
    const reason = new Error("R installation cancelled");
    let settled = false;
    const pending = server.installServer({
      storagePath: directory,
      signal: controller.signal,
      api: { signal: controller.signal, resolver: {}, setServerInstallationStatus() {} },
    });
    const observed = pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await conditionPromise(() => childProcess.execFile.calls.any());
    controller.abort(reason);
    complete(reason, "", "");
    try {
      await new Promise(setImmediate);
      expect(settled).toBe(false);
      expect(fs.existsSync(path.join(directory, "library"))).toBe(true);
    } finally {
      child.emit("close", null, "SIGTERM");
      await observed;
    }
    await expectAsync(pending).toBeRejectedWith(reason);
  });
  it("preserves the live process failure and its stdout and stderr diagnostics", async () => {
    const pending = server.installServer({
      storagePath: directory,
      api: { resolver: {}, setServerInstallationStatus() {} },
    });
    await conditionPromise(() => childProcess.execFile.calls.any());
    const failure = Object.assign(new Error("R install failed"), { code: 2 });
    complete(failure, "Controlled output", "Controlled diagnostic");
    child.emit("close", 2, null);
    let rejected;
    try {
      await pending;
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBe(failure);
    expect(rejected?.stdout).toBe("Controlled output");
    expect(rejected?.stderr).toBe("Controlled diagnostic");
    expect(rejected?.code).toBe(2);
  });
});
