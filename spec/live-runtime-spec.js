const childProcess = require("node:child_process");
const path = require("node:path");

describe("ide-r live server prerequisites", () => {
  let resolveLiveRuntime;
  beforeEach(() => {
    ({ resolveLiveRuntime } = require("./helpers/live-runtime"));
  });

  it("does not run optional integration when R has no languageserver package", () => {
    const probe = spyOn(childProcess, "spawnSync").and.returnValue({ status: 20 });
    expect(resolveLiveRuntime({ R_LSP_PATH: "/Rscript" })).toBeNull();
    expect(probe.calls.mostRecent().args[1]).toContain(
      "if (!requireNamespace('languageserver', quietly=TRUE)) quit(status=20L)",
    );
  });

  it("requires both the runtime and languageserver when integration CI requests them", () => {
    spyOn(childProcess, "spawnSync").and.returnValue({ status: 20 });
    for (const requirement of ["REQUIRE_R_LSP", "REQUIRE_R_MANAGED_INSTALL"]) {
      expect(() => resolveLiveRuntime({ PATH: "", [requirement]: "1" })).toThrowError(
        /CI requires Rscript and the real R languageserver package/,
      );
      expect(() => resolveLiveRuntime({ R_LSP_PATH: "/Rscript", [requirement]: "1" })).toThrowError(
        /CI requires Rscript and the real R languageserver package/,
      );
    }
  });

  it("checks the selected server library without discarding existing user libraries", () => {
    const probe = spyOn(childProcess, "spawnSync").and.returnValue({ status: 0 });
    expect(
      resolveLiveRuntime({
        R_LSP_PATH: "/Rscript",
        R_LSP_LIBRARY: "/selected",
        R_LIBS: "existing",
      }),
    ).toBe("/Rscript");
    expect(probe.calls.mostRecent().args[2].env.R_LIBS).toBe(`/selected${path.delimiter}existing`);
  });

  it("fails unexpected prerequisite probe errors instead of skipping integration", () => {
    const probe = spyOn(childProcess, "spawnSync").and.returnValue({
      status: 1,
      stderr: "R initialization failed",
    });
    expect(() => resolveLiveRuntime({ R_LSP_PATH: "/Rscript" })).toThrowError(
      /R initialization failed/,
    );
    probe.and.returnValue({ status: null, error: new Error("probe timed out") });
    expect(() => resolveLiveRuntime({ R_LSP_PATH: "/Rscript" })).toThrowError(/probe timed out/);
  });
});
