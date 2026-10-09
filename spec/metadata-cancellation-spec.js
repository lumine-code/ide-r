const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { promisify } = require("node:util");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

describe("R metadata and installer lifetime", () => {
  let server, controller, execute, nativeJob;
  const marker = path.join(__dirname, "controlled-rscript");
  const originalRun = promisify(childProcess.execFile);
  const result = { stdout: "0.3.20\n" };
  const installed = { stdout: "LUMINE_SERVER_VERSION=0.3.20\n" };
  function deferred() {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  const context = () => ({ signal: controller.signal, resolver: {} });
  const installation = () => ({
    api: {
      signal: controller.signal,
      resolver: {},
      setServerInstallationStatus: jasmine.createSpy("installationStatus"),
    },
    storagePath: path.join(lumine.getConfigDirPath(), "controlled-r-stage"),
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    const loaded = lumine.packages.getLoadedPackage("ide-r");
    const packagePath = path.resolve(__dirname, "..");
    await lumine.packages.deactivatePackage("ide-r");
    if (loaded) await lumine.packages.unloadPackage("ide-r");
    const serverPath = path.join(packagePath, "lib", "server.js");
    execute = jasmine.createSpy("Rscript").and.resolveTo(result);
    controller = new AbortController();
    nativeJob = null;
    const originalLoad = Module._load;
    const controlledExec = (command, args, options, callback) => {
      if (command !== marker) throw new Error("Unexpected external executable");
      const child = new EventEmitter();
      execute(args, options).then(
        (value) => {
          callback(null, value.stdout, value.stderr || "");
          child.emit("close", 0, null);
        },
        (error) => {
          callback(error, "", "");
          child.emit("close", null, null);
        },
      );
      return child;
    };
    controlledExec[promisify.custom] = (command, args, options) => {
      if (command !== marker) throw new Error("Unexpected external executable");
      return execute(args, options);
    };
    // Substitute only this module's process boundary, leaving Core and all
    // other modules on the real Node loader and child_process implementation.
    spyOn(Module, "_load").and.callFake(function (name, parent, ...rest) {
      const value = originalLoad.call(this, name, parent, ...rest);
      return name === "child_process" && parent?.filename === serverPath
        ? { ...value, execFile: controlledExec }
        : value;
    });
    await lumine.packages.loadPackage(packagePath);
    await lumine.packages.activatePackage("ide-r");
    server = require("../lib/server");
  });
  afterEach(async () => {
    if (nativeJob) {
      if (!nativeJob.closed) nativeJob.child.kill();
      await nativeJob.finished;
    }
    await lumine.packages.deactivatePackage("ide-r");
    await lumine.packages.deactivatePackage("ide");
  });
  it("does not resolve or launch a lookup for an already cancelled API", async () => {
    const resolve = spyOn(server, "resolveRuntime").and.resolveTo({ path: marker });
    controller.abort(new Error("cancelled lookup"));
    await expectAsync(server.latestServerVersion(context())).toBeRejectedWithError(
      "cancelled lookup",
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not launch after cancelled runtime resolution", async () => {
    const held = deferred();
    spyOn(server, "resolveRuntime").and.returnValue(held.promise);
    const pending = server.latestServerVersion(context());
    controller.abort(new Error("cancelled resolution"));
    held.resolve({ path: marker });
    await expectAsync(pending).toBeRejectedWithError("cancelled resolution");
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects a lookup process completing after cancellation", async () => {
    const held = deferred();
    spyOn(server, "resolveRuntime").and.resolveTo({ path: marker });
    execute.and.returnValue(held.promise);
    const pending = server.latestServerVersion(context());
    await conditionPromise(() => execute.calls.any());
    controller.abort(new Error("cancelled metadata"));
    held.resolve(result);
    await expectAsync(pending).toBeRejectedWithError("cancelled metadata");
  });
  it("preserves current process failures, missing runtime and timeout options", async () => {
    const resolve = spyOn(server, "resolveRuntime").and.resolveTo({ path: marker });
    execute.and.rejectWith(new Error("CRAN unavailable"));
    await expectAsync(server.latestServerVersion(context())).toBeRejectedWithError(
      "CRAN unavailable",
    );
    execute.and.resolveTo(result);
    expect(await server.latestServerVersion(context())).toBe("0.3.20");
    const options = execute.calls.mostRecent().args[1];
    expect(options.timeout).toBe(60000);
    expect(options.maxBuffer).toBe(256 * 1024);
    expect(options.windowsHide).toBe(true);
    resolve.and.resolveTo(null);
    expect(await server.latestServerVersion(context())).toBeNull();
  });
  it("does not start staging or a process for an already cancelled installer", async () => {
    const resolve = spyOn(server, "resolveRuntime").and.resolveTo({ path: marker });
    const mkdir = spyOn(fs.promises, "mkdir").and.resolveTo();
    execute.and.resolveTo(installed);
    const task = installation();
    controller.abort(new Error("cancelled installation"));
    await expectAsync(server.installServer(task)).toBeRejectedWithError("cancelled installation");
    expect(resolve).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(task.api.setServerInstallationStatus).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it("forwards installer lifetime to resolution and refuses later staging", async () => {
    const held = deferred();
    const resolve = spyOn(server, "resolveRuntime").and.returnValue(held.promise);
    const mkdir = spyOn(fs.promises, "mkdir").and.resolveTo();
    execute.and.resolveTo(installed);
    const task = installation();
    const pending = server.installServer(task);
    expect(resolve.calls.mostRecent().args[0].signal).toBe(controller.signal);
    controller.abort(new Error("cancelled installer resolution"));
    held.resolve({ path: marker });
    await expectAsync(pending).toBeRejectedWithError("cancelled installer resolution");
    expect(mkdir).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not launch an installer after a delayed staging write is cancelled", async () => {
    const held = deferred();
    spyOn(server, "resolveRuntime").and.resolveTo({ path: marker });
    const mkdir = spyOn(fs.promises, "mkdir").and.returnValue(held.promise);
    execute.and.resolveTo(installed);
    const task = installation();
    const pending = server.installServer(task);
    await conditionPromise(() => mkdir.calls.any());
    controller.abort(new Error("cancelled staging"));
    held.resolve();
    await expectAsync(pending).toBeRejectedWithError("cancelled staging");
    expect(task.api.setServerInstallationStatus).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not launch when a status callback cancels the installer", async () => {
    spyOn(server, "resolveRuntime").and.resolveTo({ path: marker });
    spyOn(fs.promises, "mkdir").and.resolveTo();
    execute.and.resolveTo(installed);
    const task = installation();
    task.api.setServerInstallationStatus.and.callFake(() => {
      controller.abort(new Error("cancelled status callback"));
    });
    await expectAsync(server.installServer(task)).toBeRejectedWithError(
      "cancelled status callback",
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not return an installation record after process cancellation", async () => {
    const held = deferred();
    spyOn(server, "resolveRuntime").and.resolveTo({ path: marker });
    spyOn(fs.promises, "mkdir").and.resolveTo();
    execute.and.returnValue(held.promise);
    const pending = server.installServer(installation());
    await conditionPromise(() => execute.calls.any());
    expect(execute.calls.mostRecent().args[1].signal).toBe(controller.signal);
    expect(execute.calls.mostRecent().args[1].timeout).toBe(600000);
    controller.abort(new Error("cancelled installer process"));
    held.resolve(installed);
    await expectAsync(pending).toBeRejectedWithError("cancelled installer process");
  });
  for (const mode of ["caller cancellation", "adapter withdrawal"]) {
    it(`cancels an actual Node child through ManagedServers on ${mode}`, async () => {
      await lumine.packages.deactivatePackage("ide-r");
      const ide = (await lumine.packages.activatePackage("ide")).mainModule;
      await lumine.packages.activatePackage("ide-r");
      server = require("../lib/server");
      spyOn(server, "resolveRuntime").and.resolveTo({ path: marker });
      execute.and.callFake((_args, options) => {
        const promise = originalRun(
          process.execPath,
          ["-e", 'process.stdout.write("STARTED");setInterval(() => {}, 1000)'],
          {
            ...options,
            env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" },
          },
        );
        promise.catch(() => {});
        nativeJob = { child: promise.child, options, started: false, closed: false };
        nativeJob.finished = new Promise((resolve) => {
          nativeJob.child.once("close", () => {
            nativeJob.closed = true;
            resolve();
          });
        });
        nativeJob.child.stdout.on("data", () => {
          nativeJob.started = true;
        });
        return promise;
      });
      const managed = ide.ensureManagedServers();
      const pending = managed.latestVersion(managed.adapterFor("ide-r"), {
        force: true,
        signal: controller.signal,
      });
      await conditionPromise(() => nativeJob?.started);
      if (mode === "caller cancellation") controller.abort();
      else await lumine.packages.deactivatePackage("ide-r");
      await expectAsync(pending).toBeRejected();
      expect(nativeJob.options.signal?.aborted).toBe(true);
      if (nativeJob.options.signal?.aborted) await nativeJob.finished;
      expect(nativeJob.closed).toBe(true);
      expect(managed.latest.has("ide-r")).toBe(false);
    });
  }
});
