const { resolutionContext, findOnPath } = require("./helpers/server-resolution");
const fs = require("node:fs");
const path = require("node:path");
const { createProject, removeProject } = require("./helpers/project");

describe("ide-r runtime discovery", () => {
  let fixture, server;
  beforeEach(async () => {
    fixture = createProject();
    await lumine.packages.activatePackage("ide-r");
    server = require("../lib/server");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-r");
    removeProject(fixture.rootPath);
  });

  it("prefers an explicit runtime and rejects invalid files before switching servers", async () => {
    expect(
      (await server.resolveRuntime(resolutionContext(), process.execPath, { PATH: "" }))?.path ??
        null,
    ).toBe(process.execPath);
    await expectAsync(
      server.resolveRuntime(resolutionContext(), path.join(fixture.rootPath, "missing")),
    ).toBeRejected();
    await expectAsync(server.resolveRuntime(resolutionContext(), fixture.rootPath)).toBeRejected();
  });

  it("finds an executable on PATH and skips directories", () => {
    const name = path.basename(process.execPath, path.extname(process.execPath));
    expect(findOnPath(name, { PATH: path.dirname(process.execPath) })).toBeTruthy();
    fs.mkdirSync(path.join(fixture.rootPath, "Rscript"));
    expect(findOnPath("Rscript", { PATH: fixture.rootPath })).toBeNull();
  });

  it("describes current and historical R_HOME layouts on Windows and macOS", () => {
    const home = path.join(fixture.rootPath, "Rhome");
    const windows = server.runtimeCandidates({ R_HOME: home }, "win32");
    expect(windows).toContain(path.join(home, "bin", "Rscript.exe"));
    expect(windows).toContain(path.join(home, "bin", "x64", "Rscript.exe"));
    expect(server.runtimeCandidates({}, "darwin")).toContain(
      "/Library/Frameworks/R.framework/Resources/bin/Rscript",
    );
  });

  it("tries newest standard Windows installations first", () => {
    for (const version of ["R-4.6.1", "R-4.5.2", "R-4.10.0"])
      fs.mkdirSync(path.join(fixture.rootPath, "R", version), { recursive: true });
    const candidates = server.runtimeCandidates({ ProgramFiles: fixture.rootPath }, "win32");
    expect(candidates[0]).toBe(path.join(fixture.rootPath, "R", "R-4.10.0", "bin", "Rscript.exe"));
  });

  it("adds a selected library without replacing existing user libraries", () => {
    expect(server.libraryEnvironment("/selected", { R_LIBS: "existing" })).toEqual({
      R_LIBS: `/selected${path.delimiter}existing`,
    });
    expect(server.libraryEnvironment("", {})).toEqual({});
  });
  it("rejects a broken selected library before probing a different installed package", async () => {
    spyOn(server, "resolveRuntime").and.resolveTo({ path: process.execPath, kind: "executable" });
    await expectAsync(
      server.resolveServer(resolutionContext(), {
        libraryPath: path.join(fixture.rootPath, "missing-library"),
      }),
    ).toBeRejected();
    const library = path.join(fixture.rootPath, "managed", "library");
    fs.mkdirSync(library, { recursive: true });
    await expectAsync(
      server.resolveServer(
        resolutionContext({
          managedServer: { modulePath: path.join(library, "languageserver", "DESCRIPTION") },
        }),
      ),
    ).toBeRejected();
  });

  it("repairs only unsupported POSIX UTF-8 locales for native Windows R children", () => {
    const env = {
      LANG: "C.UTF-8",
      LC_ALL: "C.utf8",
      LC_CTYPE: "English_United Kingdom.utf8",
      LC_TIME: "C",
      R_LIBS: "existing",
    };
    const snapshot = { ...env };
    expect(server.libraryEnvironment("", env, "win32")).toEqual({ LANG: "", LC_ALL: "" });
    expect(server.libraryEnvironment("", env, "linux")).toEqual({});
    expect(server.libraryEnvironment("", env, "darwin")).toEqual({});
    expect(env).toEqual(snapshot);
  });

  it("does not mutate the process environment while selecting R child libraries and locales", () => {
    const snapshot = {
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_CTYPE: process.env.LC_CTYPE,
      R_LIBS: process.env.R_LIBS,
    };
    server.libraryEnvironment("/selected", process.env, "win32");
    for (const [key, value] of Object.entries(snapshot)) expect(process.env[key]).toBe(value);
  });

  it("returns null when R is unavailable", async () => {
    spyOn(server, "resolveRuntime").and.resolveTo(null);
    expect(
      await server.resolveServer(resolutionContext({ managedServer: null }), {
        serverPath: "",
        libraryPath: "",
      }),
    ).toBeNull();
  });

  it("refuses CRAN mirror schemes that cannot serve package downloads", async () => {
    spyOn(server, "resolveRuntime").and.resolveTo({ path: process.execPath, kind: "executable" });
    await expectAsync(
      server.installServer(
        { storagePath: fixture.rootPath, api: { setServerInstallationStatus() {} } },
        { cranMirror: "file:///tmp/cran" },
      ),
    ).toBeRejectedWithError(/HTTP or HTTPS/);
  });
});

describe("ide-r adapter services and configuration", () => {
  let main, adapter, disposable, cleanup;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("ide-r")).mainModule;
    cleanup = jasmine.createSpy("removeAdapter");
    disposable = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose: cleanup };
      },
      reportMissingServer() {},
    });
  });
  afterEach(async () => {
    disposable.dispose();
    for (const key of [
      "parseDelay",
      "diagnosticsDelay",
      "maxCompletions",
      "richDocumentation",
      "indexMode",
      "inlayHintsMinimumArguments",
    ])
      lumine.config.unset(`ide-r.${key}`);
    await lumine.packages.deactivatePackage("ide-r");
  });

  it("registers only R and returns cleanup for the exact consumed-service edge", () => {
    expect(adapter.id).toBe("ide-r");
    expect(adapter.grammarScopes).toEqual(["source.r"]);
    expect(adapter.restartKeyPaths).toEqual(["ide-r.serverPath", "ide-r.libraryPath"]);
    disposable.dispose();
    expect(cleanup).toHaveBeenCalled();
  });

  it("keeps provider edges independent and reacquires the module after reload", async () => {
    const secondCleanup = jasmine.createSpy("secondCleanup");
    const second = main.consumeIdeClient({
      registerAdapter() {
        return { dispose: secondCleanup };
      },
    });
    disposable.dispose();
    expect(secondCleanup).not.toHaveBeenCalled();
    second.dispose();
    const packagePath = lumine.packages.getActivePackage("ide-r").path;
    await lumine.packages.deactivatePackage("ide-r");
    await lumine.packages.unloadPackage("ide-r");
    await lumine.packages.loadPackage(packagePath);
    const current = (await lumine.packages.activatePackage("ide-r")).mainModule;
    expect(current).not.toBe(main);
    expect(current.provideBackgroundTips().packageName).toBe("ide-r");
    main = current;
  });

  it("provides the settings shape requested by the R server", () => {
    lumine.config.set("ide-r.diagnosticsDelay", 0);
    lumine.config.set("ide-r.parseDelay", 0);
    lumine.config.set("ide-r.maxCompletions", 80);
    lumine.config.set("ide-r.richDocumentation", false);
    lumine.config.set("ide-r.indexMode", "off");
    lumine.config.set("ide-r.inlayHintsMinimumArguments", 1);
    const expected = {
      diagnostics_delay: 0,
      parse_delay: 0,
      max_completions: 80,
      rich_documentation: false,
      index_mode: "off",
      inlay_hints_minimum_arguments: 1,
    };
    expect(adapter.getSettings()).toEqual({ r: { lsp: expected } });
    expect(adapter.getWorkspaceConfiguration).toBeUndefined();
  });

  it("suppresses reference lenses that require VS Code client commands", () => {
    const original = { codeLensProvider: { resolveProvider: true }, hoverProvider: true };
    const transformed = adapter.transformServerCapabilities(original);
    expect(transformed.codeLensProvider).toBe(false);
    expect(original.codeLensProvider.resolveProvider).toBe(true);
    expect(transformed.hoverProvider).toBe(true);
    expect(adapter.features.codeLens).toBe(false);
    expect(require("../package.json").configSchema.features.properties.codeLens).toBeUndefined();
  });

  it("reports missing R or languageserver through the shared hub", async () => {
    const server = require("../lib/server");
    spyOn(server, "resolveServer").and.resolveTo(null);
    let registered;
    const missing = jasmine.createSpy("missing");
    const edge = main.consumeIdeClient({
      registerAdapter(value) {
        registered = value;
        return { dispose() {} };
      },
      reportMissingServer: missing,
    });
    try {
      expect(await registered.resolveServer({ rootPath: "/project" })).toBeNull();
      const args = missing.calls.mostRecent().args;
      expect(args[0]).toBe("ide-r");
      expect(typeof args[1].description).toBe("string");
    } finally {
      edge.dispose();
    }
  });
});
