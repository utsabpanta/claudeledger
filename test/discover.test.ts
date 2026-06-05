import { describe, it, expect } from "vitest";
import { decodeProjectDir, enrichProjectsFromCwd } from "../src/discover.js";
import type { RawEvent } from "../src/types.js";
import { makeSession } from "./helpers.js";

describe("decodeProjectDir", () => {
  it("turns the dash-encoded dir into a slash path (lossy)", () => {
    expect(decodeProjectDir("-Users-me-code-app")).toBe("/Users/me/code/app");
  });
});

describe("enrichProjectsFromCwd", () => {
  const cwdEvent = (cwd: string): RawEvent => ({ type: "user", cwd, message: {} });

  it("recovers the real project name from the dominant cwd", () => {
    // Decoded name would be the mangled "design"; cwd has the truth.
    const [out] = enrichProjectsFromCwd([
      makeSession(
        [cwdEvent("/Users/me/aws-system-design"), cwdEvent("/Users/me/aws-system-design")],
        { projectDir: "-Users-me-aws-system-design", projectName: "design" },
      ),
    ]);
    expect(out?.file.projectName).toBe("aws-system-design");
    expect(out?.file.projectPath).toBe("/Users/me/aws-system-design");
  });

  it("applies one project's cwd to its subagent sessions that lack cwd", () => {
    const out = enrichProjectsFromCwd([
      makeSession([cwdEvent("/Users/me/myproj")], {
        projectDir: "-Users-me-myproj",
        projectName: "myproj",
      }),
      // Subagent transcript in the same project dir, no cwd of its own.
      makeSession([{ type: "assistant", message: {} }], {
        projectDir: "-Users-me-myproj",
        projectName: "wrong",
        isSubagent: true,
      }),
    ]);
    expect(out.map((s) => s.file.projectName)).toEqual(["myproj", "myproj"]);
  });

  it("leaves sessions untouched when no event has a cwd", () => {
    const input = [
      makeSession([{ type: "assistant", message: {} }], { projectName: "decoded" }),
    ];
    const out = enrichProjectsFromCwd(input);
    expect(out[0]?.file.projectName).toBe("decoded");
  });
});
