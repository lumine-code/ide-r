# ide-r

Provide R language intelligence through languageserver.

Registers the [R languageserver](https://github.com/REditorSupport/languageserver) with `ide-client` for R source files.

## Features

- **Code intelligence**: provides completions, hover documentation and function signatures.
- **Diagnostics**: reports syntax errors and lintr findings as source changes.
- **Navigation**: finds definitions, references and document or workspace symbols.
- **Refactoring**: renames symbols and offers server fixes and refactorings.
- **Formatting**: formats documents and selections through styler.
- **Presentation**: provides semantic highlighting and parameter-name inlay hints.
- **Hierarchy**: exposes server call and type relationships to hierarchy-view.
- **Managed install**: installs languageserver and its dependencies into a private R library.
- **Project sessions**: starts one server per project root when an R editor opens.

## Installation

To install `ide-r` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/ide-r`.

Install `ide-client`, `language-r` and [R](https://www.r-project.org/). The adapter discovers Rscript on PATH, through R_HOME or in a standard Windows or macOS installation; otherwise select it in Rscript Path. Install `languageserver` through `ide-client:manage-servers`, or run `install.packages("languageserver")` in R. Install frontends such as `autocomplete`, `linter`, `hover`, `hyperclick`, `refactor` and `code-format` to display the results.

Managed installation uses the selected R runtime and may compile dependencies on platforms without CRAN binaries. Linux therefore needs the build tools and system libraries listed in the upstream installation instructions. R itself is installed separately.

## Usage

The server uses the selected R installation's package libraries. Library Path can add a project-specific library; otherwise a managed server library takes precedence when present. Project and user `.Rprofile` settings remain available to the running server, including `options(languageserver.formatting_style = ...)`; installation and discovery probes use `--vanilla`. A `.lintr` file configures diagnostics independently of the adapter's feature switches.

The adapter serves plain R files. Notebook execution and kernel completions remain provided by the Jupyter packages. Reference code lenses use VS Code client commands, so they are disabled; references remain available through `find-references`.

## Services

- `ide-client`: consumed to register R languageserver with the editor's language-server client.
- `background-tips.provider`: provided to explain R intelligence independent of notebook kernels.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
