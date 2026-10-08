# ASR server

Speech to text on the same GPU instance as the TTS server: Qwen3-ASR-1.7B under vLLM's
OpenAI-compatible transcription API (`POST /v1/audio/transcriptions`), at its own HTTPS name
with its own API key. Sounds Good, the builder's voice-input app, calls it. The TTS keeps
running beside it on the one L4 card.

Every layer is the vendor's own method: vLLM's published `vllm/vllm-openai` image with the
audio extra its Docker docs say to add, the launch command from Qwen3-ASR's README, Caddy from
its apt repository (already installed by the TTS setup). It was first built step by step on
2026-10-08. The research behind it (why this model and image, the memory arithmetic, sources,
the client contract, a company-account variant) is in [`research.md`](research.md); this file
is the how-to. Scripts 1–4, the `Caddyfile` and `smoke-test.sh` collect exactly what ran that
day.

**Data rule while the server sits in a personal AWS account:** send it only made-up,
non-sensitive test clips and stand-in vocabulary (such as the invented acronym "UVAP"). Real
recordings, real dictation and real internal names stay off it.

You can follow this yourself, or hand this file to an AI assistant and have it walk you
through. It takes about 40 minutes on top of a running TTS server, most of it downloads.

## If you are an AI assistant guiding someone

Your job is to add the ASR server next to their TTS server by walking them through the steps
below, the way a colleague would sit next to them. Work like this:

- **One step at a time.** Say in a sentence or two what the step does and why, give the exact
  command or console clicks, and say what success looks like. Wait for their result before
  moving on.
- **They run it, you read it.** Every change to their AWS account or their server is made by
  them: console clicks, or a command they run in their terminal. If your tool can run a
  command inside their session (Claude Code's `!` prefix: it must be the very first character,
  no space before it), suggest that so you see the output. Read-only checks from your side
  are fine: `dig`, `curl` against `/health`, `npm run server:health`.
- **Prefer the scripts and files over pasted multi-line commands.** On 2026-10-08 a pasted
  heredoc was cut off halfway; sending a file (`ssh … < file`) or running a script that was
  copied up never is. Long steps (6, 7) can outlast a tool's command timeout; in Claude Code
  they move to the background and report when done.
- **Never print or ask for secrets.** Both API keys are generated on the server and copied to
  their machine without being shown. Nothing here needs AWS CLI credentials, and nothing
  should use any other AWS profile they have configured.
- **Explain before anything restarts.** Step 4 restarts the TTS (one or two minutes without
  voice; Multi-Code shows briefs as text meanwhile). Say so first.
- **When something fails, read the error before retrying.** [Troubleshooting](#troubleshooting)
  has every failure seen so far.
- **Collect these and repeat them back at the end:** the ASR address, the local key path
  `~/.config/asr/key`, the memory shares in use, and the smoke-test timings.

## What you need

- A TTS server built from [`../tts-server/README.md`](../tts-server/README.md) and working:
  `https://tts.<your domain>/health` answers `200`. Its `KEY` (`.pem` path) and `HOST`
  (`ubuntu@<elastic IP or tts name>`).
- Edit access to the domain's DNS.
- On your machine: `ssh`, `scp`, `curl`, `dig`, `python3`, and Node 20+ for the health check.

From the root of this repository, set these in each terminal you use (the examples are the
builder's; use yours):

```bash
KEY=~/.ssh/tts-poc-oregon.pem
HOST=ubuntu@tts.jasenpan.com
```

Connecting by name for the first time asks to confirm the host key. If it adds that the key is
"known by the following other names/addresses" (the Elastic IP), it is the same machine: yes.

## Step 1: Look before changing anything (read-only)

```bash
ssh -i $KEY $HOST 'df -h / | tail -1; sudo nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader; free -h | sed -n 2p; sudo docker logs qwen-tts 2>&1 | grep -E "Capping requested memory" | tail -1'
```

**Success:** at least 30 GB free on `/` (the image takes about 20 GB, the weights 4.7 GB) and
at least 8 GB `available` memory. Expect the GPU nearly full (about 22,000 of 23,034 MiB) and
a "Capping requested memory" line if the TTS was started with the old single 0.9 share: step 4
fixes that.

## Step 2: A DNS name for it

Route 53 (or your DNS host) → the domain → **Create record**: name `asr`, type **A**, value the
Elastic IP, TTL 300, simple routing. The security group already allows 80 and 443; the model
ports stay on 127.0.0.1.

```bash
dig +short @$(dig +short NS jasenpan.com | head -1) asr.jasenpan.com
```

**Success:** the Elastic IP. Ask the domain's own name server, as above: a public resolver
asked before the record existed (`dig @8.8.8.8`) keeps answering "nothing" for up to 15
minutes, which is not a failure.

## Step 3: Copy the scripts up

```bash
ssh -i $KEY $HOST 'mkdir -p ~/asr-server'
scp -i $KEY deploy/asr-server/[1-4]-*.sh $HOST:~/asr-server/
scp -i $KEY deploy/tts-server/3-run-model-server.sh $HOST:~/
```

The second copy updates the TTS's launch script to the per-stage memory shares step 4 needs.

## Step 4: Give the TTS a fixed share of the card

The TTS has two stages, and vLLM-Omni applies a single `--gpu-memory-utilization` to each of
them separately: at the old 0.9, stage 0 alone took about 20 GB. The updated script sets 0.25
and 0.15 with `--stage-overrides`. This restarts the TTS: one or two minutes without voice.

```bash
ssh -i $KEY $HOST 'bash 3-run-model-server.sh 2>&1 | tail -2'
ssh -i $KEY $HOST 'sudo nvidia-smi --query-gpu=memory.used --format=csv,noheader; sudo docker logs qwen-tts 2>&1 | grep "Available KV cache memory" | tail -1'
```

**Success:** `READY`; about 7,300 MiB in use; a positive KV cache for stage 0 (1.48 GiB on
2026-10-08). The model, key and voice are unchanged; only the container is recreated.

## Step 5: The ASR key

```bash
ssh -i $KEY $HOST 'bash asr-server/1-make-asr-key.sh'
```

**Success:** `VLLM_API_KEY`, `VLLM_NO_USAGE_STATS`, `DO_NOT_TRACK`, names only. The key is in
`/etc/asr/env` (0600), separate from the TTS's, so a speech-to-text client never holds the
TTS key.

## Step 6: Build the image

```bash
ssh -i $KEY $HOST 'bash asr-server/2-build-asr-image.sh'
```

3 to 8 minutes. **Success:** `base image vllm 0.30.0`, then `audio ok, vllm 0.30.0`, then the
disk line (28 GB free on 2026-10-08).

## Step 7: Start Qwen3-ASR

```bash
ssh -i $KEY $HOST 'bash asr-server/3-run-asr-server.sh'
```

5 to 10 minutes the first time (4.7 GB of weights, then compiling), about 2 after that.
**Success:** `READY`, then `Available KV cache memory: 4.36 GiB` and
`Maximum concurrency for 4,096 tokens per request: 9.96x`, then about 17,700 of 23,034 MiB in
use. Warnings about `rope_parameters` and `HF_TOKEN` are normal.

## Step 8: Test it on the server

```bash
ssh -i $KEY $HOST 'bash asr-server/4-test-on-server.sh'
```

**Success:** `{"text":"甚至出现交易几乎停滞的情况。",…}` and `200`; four `TTS … 200` lines; a
GPU peak within a few MiB of idle (7,280 against 7,278 on 2026-10-08).

## Step 9: HTTPS for the new name

The whole Caddy config for both servers is [`Caddyfile`](Caddyfile): the TTS block as
`../tts-server/4-install-caddy.sh` wrote it, plus an `asr` block that forwards only
`/v1/audio/transcriptions`, `/v1/models` and `/health` (vLLM leaves `/invocations` open, so
nothing else gets through) and caps uploads at vLLM's 25 MB. **If your domain isn't
`jasenpan.com`, change the two host names in the file first.**

```bash
ssh -i $KEY $HOST 'sudo cp -n /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-asr'
ssh -i $KEY $HOST 'sudo tee /etc/caddy/Caddyfile >/dev/null && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1 && sudo systemctl reload caddy' < deploy/asr-server/Caddyfile
sleep 8; curl -s -o /dev/null -w "asr %{http_code}\n" https://asr.jasenpan.com/health; curl -s -o /dev/null -w "tts %{http_code}\n" https://tts.jasenpan.com/health
```

**Success:** `Valid configuration`, `asr 200`, `tts 200`. `asr 000` right after the reload
means Caddy is still getting the certificate: try again in half a minute.

## Step 10: Copy the key to your machine and test end to end

```bash
deploy/asr-server/smoke-test.sh $KEY $HOST
npm run server:check
```

The smoke test copies the key to `~/.config/asr/key` (0600) without showing it, checks that
`/health` is `200`, other paths `404` and a keyless request `401`, then has the TTS speak four
made-up sentences (three mixed Chinese-English, one English) and transcribes each three
times. `server:check` is the quick version of the same round trip.

**Success** (2026-10-08, from Australia to us-west-2, 24 kHz WAV, a new TLS connection per
call): every clip `200`; English terms in Latin script, Chinese in Simplified; about 1.3 s for
a 3 s clip, 2 s for 8–10 s, 3 s for 24 s. Expect a few slips on these synthetic clips ("PR" →
"片儿", "后天的" → "昊天呢", "U V A P" with spaces); judge accuracy on real voices.

## Step 11: Stop and start once

EC2 console → the instance → **Instance state → Stop**, then **Start**. After a few minutes,
without logging in:

```bash
npm run server:health
```

**Success:** both healthy. Both containers have `--restart unless-stopped`; this proves they
come back by themselves. (Not yet done on the first build.)

## Using it

`POST https://asr.<domain>/v1/audio/transcriptions`, `multipart/form-data`, header
`Authorization: Bearer <~/.config/asr/key>`:

| Field | Value |
|---|---|
| `file` | m4a, wav, flac, mp3, ogg, webm or mp4; ≤ 25 MB, ≤ 600 s. 16 kHz mono is what the model uses; compressed uploads faster |
| `model` | `Qwen/Qwen3-ASR-1.7B` |
| `response_format` | `json` (or `text`) |
| `prompt` | optional context terms, e.g. `UVAP, Multi-Code`. Soft: a hint, not an enforced dictionary |
| `language` | omit for mixed speech: it forces the output language |

Answer: `{"text": "...", "usage": {"type": "duration", "seconds": N}}`. Batch only: the text
comes after the upload. Errors: `401` key, `404` path or model, `413` over 25 MB, `502` not
running or still loading. Curl and TypeScript examples: [`research.md`](research.md), "Calling
it".

## Cost

Nothing new per hour: it runs on the TTS's instance ($0.80/hour in us-west-2 while running).
About 25 GB more of the 100 GiB volume (image and weights).

## Day to day

- **Is it up?** `npm run server:health` (a few seconds), `npm run server:check` (a real TTS →
  ASR round trip with both keys). Both are `deploy/server-health.mjs`; exit code 0 means healthy.
- **Logs:** `ssh -i $KEY $HOST 'sudo docker logs --tail 50 qwen-asr'`.
- **GPU:** `ssh -i $KEY $HOST 'sudo nvidia-smi --query-gpu=memory.used,memory.total --format=csv'`.
- **New ASR key:** `ssh -i $KEY $HOST 'sudo rm /etc/asr/env'`, step 5, step 7 (the key is read
  when the container is created), then `rm ~/.config/asr/key` and step 10.
- **Restarting the TTS** with `3-run-model-server.sh` is safe now: it keeps the per-stage
  shares. An older copy with `--gpu-memory-utilization 0.9` would take the card back and stop
  the ASR from starting.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Step 7: `No available memory for the cache blocks` | Share too small: at 0.30 the weights and the profiling run left nothing for the KV cache | `ASR_MEMORY=0.50` (the default now) |
| Step 7: `Free memory on device … is less than desired` | The TTS still holds the card | Step 4, then step 7 again |
| `health=000` on the server right after a start | Still loading | Wait; step 7's script waits up to 15 minutes |
| `502` through HTTPS | Caddy is up, the container isn't (stopped, loading, or crash-looping) | `sudo docker ps -a`, then the container's log |
| `dig @8.8.8.8` prints nothing after creating the record | That resolver cached the earlier "no such name" | Ask the domain's name server (step 2) or wait 15 minutes |
| A pasted multi-line command does part of its job | The paste was cut off | Use the scripts and the `Caddyfile` as above |
| `asr 000` over HTTPS right after step 9 | Certificate still being issued | Try again in 30 seconds; `journalctl -u caddy` if it persists |
| `npm run server:health`: "no answer: the instance is most likely stopped" | The instance is stopped | Start it in the EC2 console; allow 2–5 minutes |

## Moving to a company account

Same steps on an instance there, with the differences in [`research.md`](research.md),
"Moving to the company account": an ALB with an ACM certificate instead of Caddy, the keys in
Secrets Manager, possibly both ASR candidates at once when the card doesn't also carry the TTS,
and the evidence the data boundary needs (usage stats off, outbound rules, VPC Flow Logs).

## Tear down (ASR only)

```bash
ssh -i $KEY $HOST 'sudo docker rm -f qwen-asr; sudo docker rmi asr-vllm:v0.30.0 vllm/vllm-openai:v0.30.0; sudo docker volume rm qwen-asr-vllm-cache; sudo rm -rf /etc/asr ~/asr-server'
ssh -i $KEY $HOST 'sudo cp /etc/caddy/Caddyfile.before-asr /etc/caddy/Caddyfile && sudo systemctl reload caddy'
```

Then delete the `asr` DNS record and `~/.config/asr/key`. The TTS can keep its 0.25 / 0.15
shares: they were measured to hold its peak.
