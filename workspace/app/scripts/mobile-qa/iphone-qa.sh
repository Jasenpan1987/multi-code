#!/usr/bin/env bash
# Starts the dev build for the builder's iPhone test (docs/specs/mobile-v2/test-plan-iphone.md):
# an isolated Multi-Code with its own userData, its phone server on port 6799, the real
# Tailscale checks, and two scratch Claude contacts. The installed Multi-Code (port
# 6768, its own userData) is never touched. See README.md beside this file.
#
#   scripts/mobile-qa/iphone-qa.sh                      # from workspace/app, after pnpm build
#   scripts/mobile-qa/iphone-qa.sh --dry-run <checks>   # fake Tailscale checks, separate dirs
#
# --dry-run reads the Tailscale and HTTPS checks from <checks> (MULTICODE_DEV_REMOTE_CHECKS,
# as dev-overrides.ts reads it) and uses /tmp/mc-iphone-qa-dry and
# /tmp/mc-iphone-qa-dry-projects, so trying the script changes neither Tailscale nor the
# real run's pairing. QA_CDP_PORT=<n> adds --remote-debugging-port=<n>.

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=6799
USER_DATA=/tmp/mc-iphone-qa
PROJECTS=/tmp/mc-iphone-qa-projects
CHECKS=""

if [[ "${1:-}" == "--dry-run" ]]; then
  CHECKS="${2:-}"
  if [[ -z "$CHECKS" || ! -f "$CHECKS" ]]; then
    echo "--dry-run needs a checks file (JSON as MULTICODE_DEV_REMOTE_CHECKS takes)." >&2
    exit 2
  fi
  # Absolute: Electron reads it after the cd below.
  CHECKS="$(cd "$(dirname "$CHECKS")" && pwd)/$(basename "$CHECKS")"
  USER_DATA=/tmp/mc-iphone-qa-dry
  PROJECTS=/tmp/mc-iphone-qa-dry-projects
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--dry-run <checks.json>]" >&2
  exit 2
fi

for built in dist/main/index.js dist/renderer/index.html dist/renderer-mobile/index.html; do
  if [[ ! -f "$APP_DIR/$built" ]]; then
    echo "No $built: run 'pnpm build' in $APP_DIR first." >&2
    exit 1
  fi
done

if pgrep -f -- "--user-data-dir=$USER_DATA( |$)" > /dev/null; then
  echo "A Multi-Code with --user-data-dir=$USER_DATA is already running. Use that window." >&2
  exit 1
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN > /dev/null 2>&1; then
  echo "Port $PORT is in use (lsof -nP -iTCP:$PORT -sTCP:LISTEN). Free it first." >&2
  exit 1
fi

# /tmp is shared: refuse a directory or file there that is a link (it could lead to the
# installed app's userData) or isn't this user's.
for path in "$USER_DATA" "$USER_DATA/contacts.json" "$USER_DATA/settings.json" "$PROJECTS"; do
  if [[ -L "$path" ]] || { [[ -e "$path" ]] && [[ ! -O "$path" ]]; }; then
    echo "$path is a link or isn't yours: remove it, then run this again." >&2
    exit 1
  fi
done

# Two scratch projects, made once: Haiku, and an `ask` rule in one so touch asks first.
mkdir -p "$PROJECTS/qa-ask/.claude" "$PROJECTS/qa-plain/.claude"
[[ -f "$PROJECTS/qa-ask/.claude/settings.json" ]] || cat > "$PROJECTS/qa-ask/.claude/settings.json" <<'JSON'
{
  "model": "haiku",
  "permissions": { "ask": ["Bash(touch:*)"] }
}
JSON
[[ -f "$PROJECTS/qa-plain/.claude/settings.json" ]] || cat > "$PROJECTS/qa-plain/.claude/settings.json" <<'JSON'
{
  "model": "haiku"
}
JSON
[[ -f "$PROJECTS/qa-ask/README.md" ]] || echo "# Scratch project for the iPhone test (permission dialogs)" > "$PROJECTS/qa-ask/README.md"
[[ -f "$PROJECTS/qa-plain/README.md" ]] || echo "# Scratch project for the iPhone test" > "$PROJECTS/qa-plain/README.md"

# The contacts, added once (a contact already there, or any other, is left as it is), and
# the phone link on at the first start.
mkdir -p "$USER_DATA"
USER_DATA="$USER_DATA" PROJECTS="$PROJECTS" node --input-type=module -e '
  import fs from "node:fs";
  const file = `${process.env.USER_DATA}/contacts.json`;
  let contacts = [];
  try { contacts = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (!Array.isArray(contacts)) contacts = [];
  const wanted = [
    { id: "iphone-qa-ask", cwd: `${process.env.PROJECTS}/qa-ask`, alias: "qa-ask", backend: "claude" },
    { id: "iphone-qa-plain", cwd: `${process.env.PROJECTS}/qa-plain`, alias: "qa-plain", backend: "claude" },
  ];
  const added = wanted.filter((w) => !contacts.some((c) => c.id === w.id));
  if (added.length) fs.writeFileSync(file, JSON.stringify([...contacts, ...added], null, 2));
  const settings = `${process.env.USER_DATA}/settings.json`;
  if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({ remoteEnabled: true }, null, 2));
  console.log(added.length ? `Added ${added.map((a) => a.alias).join(", ")}.` : "Contacts already there.");
'

echo "Multi-Code (dev) · userData $USER_DATA · phone server on 127.0.0.1:$PORT"
if [[ -n "$CHECKS" ]]; then
  echo "Dry run: Tailscale and HTTPS checks from $CHECKS; nothing touches Tailscale."
else
  echo "Real Tailscale checks. \"Set up HTTPS\" runs: tailscale serve --bg --https=443 http://127.0.0.1:$PORT"
fi

cd "$APP_DIR"
unset MULTICODE_DEV_REMOTE_CHECKS
ARGS=(--user-data-dir="$USER_DATA")
[[ -n "${QA_CDP_PORT:-}" ]] && ARGS+=(--remote-debugging-port="$QA_CDP_PORT")
if [[ -n "$CHECKS" ]]; then
  export MULTICODE_DEV_REMOTE_CHECKS="$CHECKS"
fi
MULTICODE_DEBUG=1 MULTICODE_DEV_REMOTE_PORT="$PORT" exec ./node_modules/.bin/electron . "${ARGS[@]}"
