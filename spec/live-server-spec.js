const { resolveLiveRuntime } = require("./helpers/live-runtime");
const path = require("node:path");
const { LiveLspClient } = require("./helpers/live-lsp-client");
const { createProject, removeProject } = require("./helpers/project");
const {
  exerciseIntelligence,
  exerciseDiagnosticEdits,
  exerciseUnicodeRename,
} = require("./helpers/exercise-server");

const runtime = resolveLiveRuntime();
const liveSuite = runtime ? describe : xdescribe;

liveSuite("ide-r real languageserver protocol", () => {
  let fixture, client, registration, originalTimeout;
  beforeAll(() => {
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 90000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    fixture = createProject();
    const main = (await lumine.packages.activatePackage("ide-r")).mainModule;
    lumine.config.set("ide-r.serverPath", runtime);
    if (process.env.R_LSP_LIBRARY)
      lumine.config.set("ide-r.libraryPath", process.env.R_LSP_LIBRARY);
    lumine.config.set("ide-r.parseDelay", 0);
    lumine.config.set("ide-r.diagnosticsDelay", 0);
    registration = main.consumeIde({
      registerAdapter(adapter) {
        client = new LiveLspClient(adapter, fixture.rootPath);
        return { dispose() {} };
      },
      reportMissingServer() {
        throw new Error("The real R server is missing.");
      },
    });
    const launch = await client.adapter.resolveServer(
      resolutionContext({ rootPath: fixture.rootPath }),
    );
    if (process.env.R_LSP_VERSION) expect(launch.version).toBe(process.env.R_LSP_VERSION);
    await client.start();
  });
  afterEach(async () => {
    await client?.stop();
    registration?.dispose();
    for (const key of ["serverPath", "libraryPath", "parseDelay", "diagnosticsDelay"])
      lumine.config.unset(`ide-r.${key}`);
    await lumine.packages.deactivatePackage("ide-r");
    removeProject(fixture.rootPath);
  });

  it("serves intelligence, navigation, formatting, hints, colours, links and hierarchies", async () => {
    const covered = await exerciseIntelligence(client, fixture);
    expect(covered).toContain("type subtypes");
    expect(covered).toContain("resolved document links");
  });
  it("updates and clears diagnostics and applies a real code action", async () => {
    const covered = await exerciseDiagnosticEdits(client, fixture);
    expect(covered).toContain("quick-fix edits");
    expect(covered).toContain("diagnostics after applying edits");
  });
  it("initiates references and rename after an astral character using UTF-16 ranges", async () => {
    const covered = await exerciseUnicodeRename(client, fixture);
    expect(covered).toContain("UTF-16 rename edits");
  });

  if (process.env.REQUIRE_R_MANAGED_INSTALL)
    it("installs CRAN languageserver into fresh staging and launches the managed copy", async () => {
      await client.stop();
      const server = require("../lib/server");
      const staging = createProject();
      const storagePath = path.join(staging.rootPath, "managed");
      try {
        const installed = await server.installServer(
          {
            storagePath,
            api: { resolver: resolutionContext().resolver, setServerInstallationStatus() {} },
          },
          { serverPath: runtime, downloadMethod: process.env.R_LSP_DOWNLOAD_METHOD || "auto" },
        );
        expect(installed.version).toMatch(/^\d+(?:\.\d+)+$/);
        expect(installed.module).toBe(path.join("library", "languageserver", "DESCRIPTION"));
        lumine.config.set("ide-r.libraryPath", "");
        await client.start({
          modulePath: path.join(storagePath, installed.module),
          version: installed.version,
        });
        client.open(fixture.uri, "r", fixture.text);
        await client.waitFor(
          () =>
            client
              .messages("textDocument/publishDiagnostics")
              .some(({ params }) => params.uri === fixture.uri),
          "managed R document parsing",
        );
        const formatted = await client.request("textDocument/formatting", {
          textDocument: { uri: fixture.uri },
          options: { tabSize: 2, insertSpaces: true },
        });
        expect(formatted.length).toBeGreaterThan(0);
      } finally {
        await client.stop();
        removeProject(staging.rootPath);
      }
    }, 600000);
});
const { resolutionContext } = require("./helpers/server-resolution");
