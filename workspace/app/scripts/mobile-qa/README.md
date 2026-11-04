# iPhone test session

`iphone-qa.sh` starts the dev build for the builder's iPhone test
(`docs/specs/mobile-v2/test-plan-iphone.md`), beside the installed Multi-Code:

| | Installed Multi-Code | This dev build |
|---|---|---|
| userData | `~/Library/Application Support/Multi-Code/` | `/tmp/mc-iphone-qa` (kept across runs, so the phone stays paired) |
| Phone server | port 6768 | `127.0.0.1:6799` (`MULTICODE_DEV_REMOTE_PORT`) |
| Tailscale checks | real | real (no `MULTICODE_DEV_REMOTE_CHECKS`) |

The script never touches the installed app, its userData or its port. It only reads
Tailscale (`tailscale status --json`, `tailscale serve status --json`); Tailscale changes
only when you press **Set up HTTPS** in the Phone panel.

## Run it

```bash
cd workspace/app
pnpm build
scripts/mobile-qa/iphone-qa.sh
```

The window has the orange DEV strip. The first run adds two contacts, once, in
`/tmp/mc-iphone-qa-projects/`, both on Haiku:

- **qa-ask**: its `.claude/settings.json` has the `ask` rule `Bash(touch:*)`, so asking it
  to `touch` a file opens a permission dialog.
- **qa-plain**: no rule.

Starting a contact the first time, Claude asks whether you trust the folder, with **No**
selected: press ↓ then Return at the desk. Stop the contacts before you quit the window,
or a dialog asks about the running sessions. `MULTICODE_DEBUG=1` is on, so
pushes and dialogs leave a trace in `$TMPDIR/multicode-debug.log`.

## Tailscale and HTTPS

1. Tailscale running on the Mac and the iPhone, same tailnet.
2. HTTPS Certificates on, in the admin console's DNS page (the panel links to it).
3. Toolbox › Phone › **Set up HTTPS** shows the command, and **Run it** runs:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:6799
   ```

   It stays after Multi-Code quits. Multi-Code never removes it.

## After the release

The released app listens on 6768, and port 443 still points at 6799, so its Phone panel
shows a conflict ("Port 443 already serves …") and offers no QR. To move it over:

```bash
tailscale serve --https=443 off
```

then press **Set up HTTPS** in the released app. The address
(`https://<machine>.<tailnet>.ts.net`) is the same, so the iPhone keeps its Home Screen
icon, but the released app has its own keys and paired phones: pair the phone again
(Toolbox › Phone › Pair a phone, then Paste pairing link in the Home Screen app).

## Trying the script without Tailscale

```bash
echo '{ "tailscale": { "state": "running", "dnsName": "mac.example.ts.net", "ip": "100.64.0.9" },
        "https": { "state": "serve-missing", "command": "tailscale serve --bg --https=443 http://127.0.0.1:6799" } }' > /tmp/checks.json
scripts/mobile-qa/iphone-qa.sh --dry-run /tmp/checks.json
```

A dry run reads the checks from that file, runs nothing when **Set up HTTPS** is pressed,
and uses `/tmp/mc-iphone-qa-dry` and `/tmp/mc-iphone-qa-dry-projects`, so the real run's
pairing is left alone. `QA_CDP_PORT=<n>` adds `--remote-debugging-port=<n>` either way.
