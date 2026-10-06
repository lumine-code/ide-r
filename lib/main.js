const server = require("./server");
const path = require("path");

const setting = (key) => lumine.config.get(`ide-r.${key}`);
const installOptions = () => ({
  serverPath: setting("serverPath"),
  cranMirror: setting("cranMirror"),
  downloadMethod: setting("downloadMethod"),
});
const options = () => ({
  diagnostics_delay: setting("diagnosticsDelay"),
  parse_delay: setting("parseDelay"),
  max_completions: setting("maxCompletions"),
  rich_documentation: setting("richDocumentation"),
  index_mode: setting("indexMode"),
  inlay_hints_minimum_arguments: setting("inlayHintsMinimumArguments"),
});

module.exports = {
  consumeIde(service) {
    return service.registerAdapter({
      id: "ide-r",
      displayName: "R Language Server",
      grammarScopes: ["source.r"],
      languageId: "r",
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-r"],
      restartKeyPaths: ["ide-r.serverPath", "ide-r.libraryPath"],
      // Reference lenses name VS Code client commands, which the hub cannot execute.
      features: { codeLens: false },
      transformServerCapabilities(capabilities) {
        return { ...capabilities, codeLensProvider: false };
      },
      installServer(context) {
        return server.installServer(context, installOptions());
      },
      latestServerVersion(api) {
        return server.latestServerVersion({ resolver: api.resolver }, installOptions());
      },
      async resolveServer(context) {
        const library = setting("libraryPath");
        const launch = await server.resolveServer(context, {
          serverPath: setting("serverPath"),
          libraryPath: library ? path.resolve(context.rootPath, library) : "",
        });
        if (!launch) {
          service.reportMissingServer("ide-r", {
            description:
              "Install [R](https://www.r-project.org/) and its `languageserver` package, or select Rscript in the ide-r settings. Once R is installed, Manage Servers can install languageserver for you.",
          });
          return null;
        }
        return { ...launch, cwd: context.rootPath, transport: "stdio" };
      },
      getSettings() {
        return { r: { lsp: options() } };
      },
    });
  },

  provideBackgroundTips() {
    return {
      packageName: "ide-r",
      tips: [
        "With ide-r, the languageserver R package provides completions, documentation and project navigation without starting a notebook kernel.",
      ],
    };
  },
};
