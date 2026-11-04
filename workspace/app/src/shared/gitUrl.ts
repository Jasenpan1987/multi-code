// The Git links the New Instance dialog's Clone mode takes (epic new-project). Shared:
// the dialog checks a link and shows the repo's name as it is typed; main checks it
// again before git runs.

// A URL with a host and a path: https, ssh:// and git://. No file:// or local paths:
// Clone mode clones from a Git host.
const URL_FORM = /^(?:https?|ssh|git):\/\/[^/\s]+\/\S+$/i;
// scp-like SSH, as GitHub's "Clone" button gives it: `git@github.com:owner/repo.git`.
// User and host start with a letter or digit, so neither can pass for an option.
const SCP_FORM = /^[A-Za-z0-9][\w.-]*@[A-Za-z0-9][\w.-]*:\S+$/;
// A GitHub page: the repo's URL, then whatever of it was open (`/tree/main`, `/pull/3`,
// `?tab=readme`). git can't clone the page itself.
const GITHUB_PAGE = /^(https?:\/\/(?:www\.)?github\.com\/[^/\s?#]+\/[^/\s?#]+)/i;

// What git is given for a pasted link, or null when it isn't a Git link. `owner/repo`
// alone is not one: it says nothing of the host.
export function cloneUrlOf(input: string): string | null {
  const text = input.trim();
  const page = GITHUB_PAGE.exec(text);
  if (page) return page[1];
  if (URL_FORM.test(text) || SCP_FORM.test(text)) return text;
  return null;
}

// The folder `git clone <url>` makes: the link's last path part without `.git`.
// "" for a link that has none.
export function repoNameOf(input: string): string {
  const url = cloneUrlOf(input) ?? input.trim();
  const path = url.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const last = path.split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "");
}

// Why a typed folder name can't be used, or null when it can. It names one folder
// in "Clone into", so no separators and no `.` or `..`.
export function folderNameProblem(name: string): string | null {
  if (name.includes("/")) return "A folder name cannot contain /";
  if (name === "." || name === "..") return "Enter a folder name";
  return null;
}
