import { describe, expect, it } from "vitest";
import { cloneUrlOf, folderNameProblem, repoNameOf } from "./gitUrl";

describe("cloneUrlOf", () => {
  it("takes the links GitHub and other hosts give", () => {
    for (const url of [
      "git@github.com:acme/acme-admin.git",
      "https://github.com/acme/acme-admin.git",
      "https://gitlab.example.com/team/sub/app.git",
      "ssh://git@host.example.com:2222/team/app.git",
      "git://example.com/app.git",
    ]) {
      expect(cloneUrlOf(url)).toBe(url);
    }
  });

  it("turns a GitHub page into its repo's URL", () => {
    expect(cloneUrlOf("https://github.com/acme/docs-site")).toBe(
      "https://github.com/acme/docs-site"
    );
    expect(cloneUrlOf("https://github.com/acme/docs-site/tree/main/src")).toBe(
      "https://github.com/acme/docs-site"
    );
    expect(cloneUrlOf("https://github.com/acme/docs-site?tab=readme-ov-file#setup")).toBe(
      "https://github.com/acme/docs-site"
    );
    expect(cloneUrlOf("  https://www.github.com/a/b/pull/3  ")).toBe("https://www.github.com/a/b");
  });

  it("refuses what isn't a Git link", () => {
    for (const text of [
      "",
      "acme/some-repo",
      "~/code/work/multi-code",
      "/Users/me/repo",
      "file:///Users/me/repo",
      "https://github.com",
      "https://example.com/",
      "-u@host:path",
      "git@-oProxyCommand:x",
      "git@github.com:a/b c",
    ]) {
      expect(cloneUrlOf(text), text).toBeNull();
    }
  });
});

describe("repoNameOf", () => {
  it("is the folder git clone makes", () => {
    expect(repoNameOf("git@github.com:acme/acme-admin.git")).toBe("acme-admin");
    expect(repoNameOf("https://github.com/acme/docs-site/tree/main")).toBe("docs-site");
    expect(repoNameOf("https://gitlab.example.com/team/app.git/")).toBe("app");
    expect(repoNameOf("git@host:app")).toBe("app");
    expect(repoNameOf("https://example.com/a/My.Repo.GIT")).toBe("My.Repo");
  });

  it("is empty when there is nothing to name", () => {
    expect(repoNameOf("")).toBe("");
  });
});

describe("folderNameProblem", () => {
  it("allows one folder name", () => {
    expect(folderNameProblem("portals-v2")).toBeNull();
    expect(folderNameProblem("my repo")).toBeNull();
  });

  it("refuses paths and dot names", () => {
    expect(folderNameProblem("a/b")).toMatch(/cannot contain \//);
    expect(folderNameProblem(".")).not.toBeNull();
    expect(folderNameProblem("..")).not.toBeNull();
  });
});
