const { createProject, removeProject, position } = require("./helpers/project");
const { findOnPath } = require("../lib/server");
const runtime = process.env.R_LSP_PATH || findOnPath("Rscript");
const liveSuite = runtime ? describe : xdescribe;

const until = async (check, label) => {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
};

liveSuite("ide-r actual editor service routing", () => {
  let fixture, editor, paths, service, timeout;
  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 90000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    fixture = createProject();
    paths = lumine.project.getPaths();
    for (const name of ["language-r", "ide-client", "ide-r"])
      await lumine.packages.activatePackage(name);
    lumine.config.set("ide-r.serverPath", runtime);
    if (process.env.R_LSP_LIBRARY)
      lumine.config.set("ide-r.libraryPath", process.env.R_LSP_LIBRARY);
    lumine.config.set("ide-r.parseDelay", 0);
    lumine.config.set("ide-r.diagnosticsDelay", 0);
    service = lumine.packages.getActivePackage("ide-client").mainModule.provideIdeClient();
    lumine.project.setPaths([fixture.rootPath]);
    editor = await lumine.workspace.open(fixture.filePath);
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.r"));
  });
  afterEach(async () => {
    editor?.destroy();
    await lumine.packages.deactivatePackage("ide-r");
    await lumine.packages.deactivatePackage("ide-client");
    await lumine.packages.deactivatePackage("language-r");
    for (const key of [
      "serverPath",
      "libraryPath",
      "parseDelay",
      "diagnosticsDelay",
      "features.format",
    ])
      lumine.config.unset(`ide-r.${key}`);
    lumine.project.setPaths(paths);
    await lumine.fileWatchClient.settlePendingTeardown();
    removeProject(fixture.rootPath);
  });
  const sessionFor = () =>
    until(
      async () =>
        (await service.activeSessionsForEditor(editor)).find(
          ({ adapter }) => adapter.id === "ide-r",
        ),
      "R session",
    );

  it("routes actual completion and formatting, respects switches and disables VS Code lenses", async () => {
    const session = await sessionFor();
    const clientMain = lumine.packages.getActivePackage("ide-client").mainModule;
    expect(session.capabilities.codeLensProvider).toBe(false);
    expect(session.supports("textDocument/codeLens", editor)).toBe(false);
    const point = position(fixture.text, "add(1, 2)", 2);
    const suggestions = await clientMain.provideAutocomplete().getSuggestions({
      editor,
      bufferPosition: new (require("lumine").Point)(point.line, point.character),
      prefix: "ad",
      activatedManually: true,
    });
    expect(
      suggestions.some((item) =>
        (item.displayText || item.text || item.snippet || "").startsWith("add"),
      ),
    ).toBe(true);
    const formatter = clientMain.provideCodeFormatFile();
    expect((await formatter.formatEntireFile(editor)).length).toBeGreaterThan(0);
    lumine.config.set("ide-r.features.format", false);
    expect(await service.activeSessionForFeature(editor, "textDocument/formatting")).toBeNull();
    expect(await formatter.formatEntireFile(editor)).toEqual([]);
    lumine.config.set("ide-r.features.format", true);
    expect(await service.activeSessionForFeature(editor, "textDocument/formatting")).toBe(session);
  });

  it("stops an unloaded generation and acquires a fresh module and server on reactivation", async () => {
    const previous = await sessionFor();
    const oldPackage = lumine.packages.getActivePackage("ide-r");
    const oldMain = oldPackage.mainModule;
    const packagePath = oldPackage.path;
    await lumine.packages.deactivatePackage("ide-r");
    await until(() => previous.state === "stopped", "R teardown");
    await lumine.packages.unloadPackage("ide-r");
    await lumine.packages.loadPackage(packagePath);
    const current = (await lumine.packages.activatePackage("ide-r")).mainModule;
    expect(current).not.toBe(oldMain);
    const renewed = await sessionFor();
    expect(renewed).not.toBe(previous);
    const hovered = await until(
      () =>
        renewed.request("textDocument/hover", {
          textDocument: { uri: fixture.uri },
          position: position(fixture.text, "add(1, 2)", 1),
        }),
      "hover after the reloaded server parses its document",
    );
    expect(JSON.stringify(hovered)).toContain("add");
  });
});
