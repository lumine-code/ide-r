const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

const source = `# Arithmetic helpers ----
add <- function(left, right = 2) {
  left + right
}

wrapper <- function(value) {
  add(value, 3)
}

answer <- add(1, 2)
unicode <- "😀"; result <- add(4, 5)
colour <- "#ff0000"
source("linked.R")

Base <- R6::R6Class("Base", public = list(value = 1))
Child <- R6::R6Class("Child", inherit = Base)
`;

const position = (text, fragment, inside = 0) => {
  const index = text.indexOf(fragment);
  if (index < 0) throw new Error(`Fixture has no '${fragment}'.`);
  const lines = text.slice(0, index + inside).split("\n");
  return { line: lines.length - 1, character: lines.at(-1).length };
};

const offset = (text, point) =>
  text
    .split("\n")
    .slice(0, point.line)
    .reduce((sum, line) => sum + line.length + 1, 0) + point.character;
const applyEdits = (text, edits) => {
  for (const edit of [...edits].sort(
    (a, b) => offset(text, b.range.start) - offset(text, a.range.start),
  ))
    text =
      text.slice(0, offset(text, edit.range.start)) +
      edit.newText +
      text.slice(offset(text, edit.range.end));
  return text;
};
const editsFor = (edit, uri) => [
  ...(edit.changes?.[uri] || []),
  ...(edit.documentChanges || [])
    .filter((item) => item.textDocument?.uri === uri)
    .flatMap((item) => item.edits || []),
];

const createProject = () => {
  const temp = fs.realpathSync.native(os.tmpdir());
  const rootPath = fs.mkdtempSync(path.join(temp, "ide-r-spec-"));
  const filePath = path.join(rootPath, "main.R");
  const linkedPath = path.join(rootPath, "linked.R");
  fs.writeFileSync(filePath, source);
  fs.writeFileSync(linkedPath, "workspace_helper <- function(value) {\n  value * 3\n}\n");
  return {
    rootPath,
    filePath,
    uri: pathToFileURL(filePath).href,
    linkedUri: pathToFileURL(linkedPath).href,
    text: source,
  };
};

const removeProject = (rootPath) => {
  const temp = fs.realpathSync.native(os.tmpdir());
  const relative = path.relative(temp, path.resolve(rootPath));
  if (path.isAbsolute(relative) || relative.startsWith("..") || !relative.startsWith("ide-r-spec-"))
    throw new Error(`Refusing to remove an unexpected scratch path: ${rootPath}`);
  fs.rmSync(rootPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

module.exports = { source, position, applyEdits, editsFor, createProject, removeProject };
