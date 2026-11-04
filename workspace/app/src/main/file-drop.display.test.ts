// How the drop dialog and message show a folder or a copy. Pure: the home directory
// is passed in, so nothing here reads the real one or touches the disk.

import { describe, expect, it } from "vitest";
import { displayPath } from "./file-drop";

const HOME = "/Users/me";
const PROJECT = "/Users/me/code/multi-code";

describe("displayPath", () => {
  it("shows a folder inside the project relative to it, with a trailing slash", () => {
    expect(displayPath(`${PROJECT}/docs/sources/inbox`, PROJECT, HOME, true)).toBe(
      "docs/sources/inbox/"
    );
  });

  it("shows a file inside the project relative to it, without one", () => {
    expect(displayPath(`${PROJECT}/docs/inbox/report 2.docx`, PROJECT, HOME, false)).toBe(
      "docs/inbox/report 2.docx"
    );
  });

  it("shows the project itself as ./", () => {
    expect(displayPath(PROJECT, PROJECT, HOME, true)).toBe("./");
    expect(displayPath(`${PROJECT}/`, PROJECT, HOME, true)).toBe("./");
  });

  it("shows a path outside the project under home with ~", () => {
    expect(displayPath("/Users/me/Downloads", PROJECT, HOME, true)).toBe("~/Downloads/");
    expect(displayPath("/Users/me/Downloads/a.png", PROJECT, HOME, false)).toBe(
      "~/Downloads/a.png"
    );
    expect(displayPath(HOME, PROJECT, HOME, true)).toBe("~/");
  });

  it("shows a path under neither in full", () => {
    expect(displayPath("/Volumes/Shared/inbox", PROJECT, HOME, true)).toBe(
      "/Volumes/Shared/inbox/"
    );
    expect(displayPath("/tmp/a.csv", PROJECT, HOME, false)).toBe("/tmp/a.csv");
    expect(displayPath("/", PROJECT, HOME, true)).toBe("/");
  });

  it("does not take a sibling that shares the project's prefix for inside it", () => {
    expect(displayPath("/Users/me/code/multi-code-t702/docs", PROJECT, HOME, true)).toBe(
      "~/code/multi-code-t702/docs/"
    );
    expect(displayPath("/Users/meg/inbox", PROJECT, HOME, true)).toBe("/Users/meg/inbox/");
  });

  it("shows a project's parent outside it", () => {
    expect(displayPath("/Users/me/code", PROJECT, HOME, true)).toBe("~/code/");
  });

  it("prefers the project when the project is outside home", () => {
    expect(displayPath("/srv/app/inbox", "/srv/app", HOME, true)).toBe("inbox/");
  });

  it("ignores a home of nothing or of the root", () => {
    expect(displayPath("/Users/me/Downloads", PROJECT, "", true)).toBe("/Users/me/Downloads/");
    expect(displayPath("/Users/me/Downloads", PROJECT, "/", true)).toBe("/Users/me/Downloads/");
  });

  it("tidies a stored path's trailing slash and dot segments", () => {
    expect(displayPath(`${PROJECT}/docs/./inbox/`, `${PROJECT}/`, HOME, true)).toBe(
      "docs/inbox/"
    );
    expect(displayPath("/Users/me/Downloads/", PROJECT, `${HOME}/`, true)).toBe("~/Downloads/");
  });
});
