const assert = require("node:assert/strict");
const { position, applyEdits, editsFor } = require("./project");

const at = (client, fixture, method, fragment, inside = 0, extra = {}) =>
  client.request(method, {
    textDocument: { uri: fixture.uri },
    position: position(fixture.text, fragment, inside),
    ...extra,
  });

const exerciseIntelligence = async (client, fixture) => {
  const results = [];
  const check = (name, condition) => {
    assert.ok(condition, `${name} returned no usable result`);
    results.push(name);
  };
  client.open(fixture.uri, "r", fixture.text);
  await client.waitFor(
    () =>
      client
        .messages("textDocument/publishDiagnostics")
        .some(({ params }) => params.uri === fixture.uri),
    "initial R diagnostics",
  );
  const completion = await at(client, fixture, "textDocument/completion", "add(1, 2)", 2);
  check(
    "symbol completion",
    (completion.items || completion).some(({ label }) => label.startsWith("add")),
  );
  const argumentsResult = await at(client, fixture, "textDocument/completion", "add(1, 2)", 7);
  check(
    "argument completion",
    (argumentsResult.items || argumentsResult).some(({ label }) => label.startsWith("right")),
  );
  const signature = await at(client, fixture, "textDocument/signatureHelp", "add(1, 2)", 7);
  check(
    "signature parameters",
    signature.signatures.some(({ label }) => label.includes("left") && label.includes("right")),
  );
  check("active signature parameter", signature.activeParameter === 1);
  const hover = await at(client, fixture, "textDocument/hover", "add(1, 2)", 1);
  check("hover", JSON.stringify(hover).includes("add"));
  const definition = await at(client, fixture, "textDocument/definition", "add(1, 2)", 1);
  check(
    "definition",
    (Array.isArray(definition) ? definition : [definition]).some(
      (item) => (item.uri || item.targetUri) === fixture.uri,
    ),
  );
  const references = await at(client, fixture, "textDocument/references", "add <-", 1, {
    context: { includeDeclaration: true },
  });
  check("references", references.length >= 4);
  const symbols = await client.request("textDocument/documentSymbol", {
    textDocument: { uri: fixture.uri },
  });
  check(
    "document symbols",
    symbols.some(({ name }) => name === "wrapper"),
  );
  const projectSymbols = await client.request("workspace/symbol", { query: "workspace_helper" });
  check(
    "workspace symbols",
    projectSymbols.some(({ name }) => name.includes("workspace_helper")),
  );
  const formatted = await client.request("textDocument/formatting", {
    textDocument: { uri: fixture.uri },
    options: { tabSize: 2, insertSpaces: true },
  });
  check(
    "formatting edits",
    formatted.length > 0 && applyEdits(fixture.text, formatted) !== fixture.text,
  );
  const hints = await client.request("textDocument/inlayHint", {
    textDocument: { uri: fixture.uri },
    range: {
      start: { line: 0, character: 0 },
      end: { line: fixture.text.split("\n").length - 1, character: 0 },
    },
  });
  check("inlay hints", hints.length > 0);
  const tokens = await client.request("textDocument/semanticTokens/full", {
    textDocument: { uri: fixture.uri },
  });
  check("semantic tokens", tokens.data.length > 0 && tokens.data.length % 5 === 0);
  const callees = await at(client, fixture, "textDocument/prepareCallHierarchy", "add <-", 1);
  check(
    "prepare call hierarchy",
    callees.some(({ name }) => name === "add"),
  );
  const incoming = await client.request("callHierarchy/incomingCalls", { item: callees[0] });
  check(
    "incoming calls",
    incoming.some(({ from }) => from.name === "wrapper"),
  );
  const callers = await at(client, fixture, "textDocument/prepareCallHierarchy", "wrapper <-", 1);
  const outgoing = await client.request("callHierarchy/outgoingCalls", { item: callers[0] });
  check(
    "outgoing calls",
    outgoing.some(({ to }) => to.name === "add"),
  );
  const parents = await at(client, fixture, "textDocument/prepareTypeHierarchy", '"Base"', 2);
  check(
    "prepare type hierarchy",
    parents.some(({ name }) => name === "Base"),
  );
  const subtypes = await client.request("typeHierarchy/subtypes", { item: parents[0] });
  check(
    "type subtypes",
    subtypes.some(({ name }) => name === "Child"),
  );
  const children = await at(client, fixture, "textDocument/prepareTypeHierarchy", '"Child"', 2);
  const supertypes = await client.request("typeHierarchy/supertypes", { item: children[0] });
  check(
    "type supertypes",
    supertypes.some(({ name }) => name === "Base"),
  );
  const folds = await client.request("textDocument/foldingRange", {
    textDocument: { uri: fixture.uri },
  });
  check(
    "folding ranges",
    folds.some((item) => item.startLine < item.endLine),
  );
  const selections = await client.request("textDocument/selectionRange", {
    textDocument: { uri: fixture.uri },
    positions: [position(fixture.text, "add(1, 2)", 1)],
  });
  check("selection ranges", selections[0].parent);
  const colours = await client.request("textDocument/documentColor", {
    textDocument: { uri: fixture.uri },
  });
  check(
    "document colours",
    colours.some(({ color }) => color.red === 1 && color.green === 0),
  );
  const presentations = await client.request("textDocument/colorPresentation", {
    textDocument: { uri: fixture.uri },
    range: colours[0].range,
    color: colours[0].color,
  });
  check(
    "colour presentations",
    presentations.some(({ label }) => label.toLowerCase() === "#ff0000"),
  );
  const links = await client.request("textDocument/documentLink", {
    textDocument: { uri: fixture.uri },
  });
  const link = links.find((item) => item.data?.path?.endsWith("linked.R"));
  check("document links", link);
  const resolvedLink = await client.request("documentLink/resolve", link);
  check("resolved document links", resolvedLink.target === fixture.linkedUri);
  return results;
};

const exerciseDiagnosticEdits = async (client, fixture) => {
  let marker = client.notifications.length;
  client.open(fixture.uri, "r", "value <- (\n");
  const diagnostics = await client.waitFor(
    () =>
      client.notifications
        .slice(marker)
        .find(
          ({ method, params }) =>
            method === "textDocument/publishDiagnostics" &&
            params.uri === fixture.uri &&
            params.diagnostics.some((item) => item.severity === 1),
        )?.params.diagnostics,
    "R parse error",
  );
  assert.ok(diagnostics.length);
  marker = client.notifications.length;
  client.change(fixture.uri, "value <- 1\n", 2);
  await client.waitFor(
    () =>
      client.notifications
        .slice(marker)
        .some(
          ({ method, params }) =>
            method === "textDocument/publishDiagnostics" &&
            params.uri === fixture.uri &&
            params.diagnostics.length === 0,
        ),
    "cleared parse diagnostics",
  );
  marker = client.notifications.length;
  const code = "value=1\n";
  client.change(fixture.uri, code, 3);
  const styleDiagnostics = await client.waitFor(
    () =>
      client.notifications
        .slice(marker)
        .find(
          ({ method, params }) =>
            method === "textDocument/publishDiagnostics" &&
            params.uri === fixture.uri &&
            params.diagnostics.some((item) => item.code === "assignment_linter"),
        )?.params.diagnostics,
    "assignment diagnostic",
  );
  const actions = await client.request("textDocument/codeAction", {
    textDocument: { uri: fixture.uri },
    range: styleDiagnostics[0].range,
    context: { diagnostics: styleDiagnostics, only: ["quickfix"] },
  });
  const action = actions.find((item) => item.edit && item.title.includes("<-"));
  assert.ok(action, "Assignment lint has no working direct edit");
  const fixed = applyEdits(code, editsFor(action.edit, fixture.uri));
  assert.ok(fixed.includes("value <- 1"), "Quick fix did not replace the assignment token");
  marker = client.notifications.length;
  client.change(fixture.uri, fixed, 4);
  await client.waitFor(
    () =>
      client.notifications
        .slice(marker)
        .some(
          ({ method, params }) =>
            method === "textDocument/publishDiagnostics" &&
            params.uri === fixture.uri &&
            params.diagnostics.length === 0,
        ),
    "diagnostics after applying quick fix",
  );
  return [
    "syntax diagnostics",
    "diagnostic clearing",
    "style diagnostics",
    "quick-fix edits",
    "diagnostics after applying edits",
  ];
};

const exerciseUnicodeRename = async (client, fixture) => {
  client.open(fixture.uri, "r", fixture.text);
  await client.waitFor(
    () =>
      client
        .messages("textDocument/publishDiagnostics")
        .some(({ params }) => params.uri === fixture.uri),
    "parsed Unicode fixture",
  );
  const start = position(fixture.text, "add(4, 5)");
  const prepared = await at(client, fixture, "textDocument/prepareRename", "add(4, 5)", 1);
  assert.equal(prepared.start.character, start.character);
  assert.equal(prepared.end.character, start.character + 3);
  const refs = await at(client, fixture, "textDocument/references", "add(4, 5)", 1, {
    context: { includeDeclaration: true },
  });
  assert.ok(
    refs.length >= 4,
    "References initiated after an astral character must find the symbol",
  );
  const occurrence = refs.find((item) => item.range.start.line === start.line);
  assert.equal(occurrence.range.start.character, start.character);
  assert.equal(occurrence.range.end.character, start.character + 3);
  const renamed = await at(client, fixture, "textDocument/rename", "add(4, 5)", 1, {
    newName: "sum_values",
  });
  assert.ok(renamed, "Rename initiated after an astral character must produce edits");
  const changed = applyEdits(fixture.text, editsFor(renamed, fixture.uri));
  assert.ok(changed.includes('unicode <- "😀"; result <- sum_values(4, 5)'));
  assert.ok(changed.includes("sum_values <- function"));
  return [
    "prepare rename after astral text",
    "references after astral text",
    "UTF-16 reference ranges",
    "rename after astral text",
    "UTF-16 rename edits",
  ];
};

module.exports = { exerciseIntelligence, exerciseDiagnosticEdits, exerciseUnicodeRename };

if (require.main === module) {
  const { LiveLspClient } = require("./live-lsp-client");
  const { createProject, removeProject } = require("./project");
  const manifest = require("../../package.json");
  const values = {
    serverPath: process.env.R_LSP_PATH,
    libraryPath: process.env.R_LSP_LIBRARY,
    parseDelay: 0,
    diagnosticsDelay: 0,
  };
  globalThis.lumine = {
    config: {
      get(key) {
        const field = key.slice(6);
        return Object.hasOwn(values, field) ? values[field] : manifest.configSchema[field]?.default;
      },
    },
  };
  let adapter;
  require("../../lib/main").consumeIde({
    registerAdapter(value) {
      adapter = value;
      return { dispose() {} };
    },
    reportMissingServer() {
      throw new Error("R server missing");
    },
  });
  (async () => {
    for (const exercise of [exerciseIntelligence, exerciseDiagnosticEdits, exerciseUnicodeRename]) {
      const fixture = createProject();
      const client = new LiveLspClient(adapter, fixture.rootPath);
      try {
        const { capabilities } = await client.start();
        console.log("CAPABILITIES", Object.keys(capabilities));
        console.log("COVERED", await exercise(client, fixture));
      } catch (error) {
        console.error(client.stderr);
        throw error;
      } finally {
        await client.stop();
        removeProject(fixture.rootPath);
      }
    }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
