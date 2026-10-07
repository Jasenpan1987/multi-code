# Voice Engine Hosting POC — investigation

**Date:** 2026-10-07
**Type:** investigation
**Participants:** Jasen (builder), Claude
**Source:** hands-on session in chat: a local trial on the builder's Mac, then an EC2 build-out the builder ran command by command; listening tests by the builder
**Feeds:** `docs/specs/voice-secretary/gaps.md` G-001 and G-003 (both resolved)

## Summary

The builder listened to Qwen3-TTS on their Mac and accepted it, then rejected running it
locally because it peaks at 6–7 GB of memory while generating. It now runs on a GPU
server in the builder's personal AWS account behind `https://tts.jasenpan.com`, using
only official components: Ubuntu's NVIDIA driver, Docker and NVIDIA's container toolkit,
vLLM-Omni's published image with its Qwen3-TTS launch command, and Caddy for HTTPS. The
builder picked Serena for both Chinese and English, and ruled that a brief's language
follows the language of the user's latest message, not a setting.

## Key Decisions

- **Qwen3-TTS-12Hz-1.7B-CustomVoice is the voice engine.** — builder, after hearing it on
  the Mac ("挺过关的", Chinese and English) and again from the server ("非常好，我非常满意").
- **Serena for both Chinese and English.** — builder, after hearing every preset in both
  languages. This replaces the call made earlier the same day to use Ryan for English.
- **A brief is in the language of the user's latest message in that session.** Pure
  English gets an English brief; Chinese or mixed gets a Chinese brief that keeps English
  technical terms. The model writing the brief reports which, and that value goes to the
  speech service as `language`. — builder. Reason: an English speaker demoing on the
  builder's machine must hear English without anyone touching a setting. Following the
  system language was proposed by the interviewer and rejected.
- **The voice runs on a server, not on the user's Mac.** — builder: at 6–7 GB peak,
  "没人用得起".
- **Not Alibaba Cloud's hosted Qwen API, not fal.ai.** — builder: no Alibaba Cloud; fal.ai
  would be a different setup from the eventual company-AWS deployment.
- **Official components only.** — builder, after rejecting a hand-written FastAPI wrapper
  around the `qwen-tts` package: "最正确、最官方的方案". Qwen's README points to vLLM-Omni for
  deployment.
- **POC on the builder's personal AWS account; the company account later.** — builder.
  The company role on this machine covers Bedrock only.
- **HTTPS by Caddy and Let's Encrypt on the instance, on the builder's own domain.** ALB
  plus ACM is the plan once this moves to the company account. — interviewer's
  recommendation, accepted. Reason: an ALB bills (~$16–20/month) even while the instance
  is stopped; Caddy stops with it.
- **The voice is optional.** If the server is stopped, unreachable or deleted, the app
  keeps working and Secretary Mode shows the brief as text instead of speaking it. —
  builder.
- **Not on company projects during the POC.** — builder, resolving G-003.
- **The setup is kept reproducible in `deploy/tts-server/`**: the scripts and a README that
  a person can follow, or hand to an AI assistant to be walked through step by step. —
  builder.

## What Was Built

| Layer | What | Source of the method |
|---|---|---|
| Machine | `qwen-tts-poc`, g6.xlarge (NVIDIA L4, 24 GB), us-west-2, Ubuntu 24.04, 100 GiB gp3, an Elastic IP | — |
| GPU driver | `nvidia-driver-580-server` (580.178.04) via `ubuntu-drivers` | Ubuntu |
| Containers | Docker Engine (apt repo) and NVIDIA Container Toolkit | docs.docker.com/engine/install/ubuntu, docs.nvidia.com container-toolkit install guide |
| Model server | `vllm/vllm-omni:v0.30.0`, container `qwen-tts`, `--restart unless-stopped`, bound to `127.0.0.1:8091` | vLLM-Omni `examples/online_serving/text_to_speech/qwen3_tts/run_server.sh` |
| Auth | `VLLM_API_KEY` in `/etc/qwen-tts/env` (root, 0600); a copy on the builder's Mac at `~/.config/qwen-tts/key` (0600) | vLLM's own API-key check |
| HTTPS | Caddy, certificate from Let's Encrypt, Route 53 A record `tts.jasenpan.com` → the Elastic IP | caddyserver.com/docs/install |
| Exposure | Only `/v1/audio/*` and `/health` pass Caddy; everything else is 404 | — |

Model server launch, verbatim:

```bash
sudo docker run -d --name qwen-tts --restart unless-stopped --runtime nvidia --gpus all --ipc=host \
  --env-file /etc/qwen-tts/env \
  -v /home/ubuntu/.cache/huggingface:/root/.cache/huggingface \
  -p 127.0.0.1:8091:8091 \
  vllm/vllm-omni:v0.30.0 \
  vllm-omni serve Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice \
    --deploy-config /app/vllm-omni/vllm_omni/deploy/qwen3_tts.yaml \
    --host 0.0.0.0 --port 8091 --gpu-memory-utilization 0.9 --trust-remote-code --omni
```

`/etc/caddy/Caddyfile`:

```
tts.jasenpan.com {
	@api path /v1/audio/* /health
	handle @api {
		reverse_proxy 127.0.0.1:8091 {
			flush_interval -1
		}
	}
	handle {
		respond 404
	}
}
```

The API is OpenAI's speech shape: `POST /v1/audio/speech` with `Authorization: Bearer
<key>` and a JSON body of `input`, `voice`, `instructions`, `language`,
`response_format`; the response body is the audio. Streaming is `"stream": true,
"stream_format": "audio", "response_format": "pcm"`. `GET /v1/audio/voices` lists the nine
presets plus `default`. Parameters: vLLM-Omni `v0.30.0` `docs/serving/speech_api.md`.

## Measurements

| Where | Setup | Result |
|---|---|---|
| Builder's Mac (M2, 24 GB) | mlx-audio 0.5.8, `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit` | 0.75–0.85 s of compute per second of audio after warm-up; 2.8 GB loaded; peak 6.3–7.2 GB per whole brief, 5.2 GB generating sentence by sentence |
| g6.xlarge (L4) | vLLM-Omni v0.30.0 | a ~13 s brief in 5.7 s, the same from the Mac over public HTTPS |

Prices seen: g6.xlarge $1.0464/h in Sydney and $0.8048/h in us-west-2; g4dn.xlarge
$0.684/h in Sydney (EC2 pricing page data, 2026-10-07).

## Facts Learned

- **Sydney had no GPU capacity.** g6.xlarge and g4dn.xlarge both failed with
  InsufficientInstanceCapacity in ap-southeast-2a, 2b and 2c. Every error named the other
  zones as available, and those failed too. us-west-2 launched on the first try with the
  subnet left at "No preference". g5 is not offered in ap-southeast-2b at all.
- **Deep Learning AMIs in Marketplace can carry software fees.** The ones the console
  search returned were Galaxys Cloud listings, up to $6.40/h on top of the instance. The
  plain Ubuntu 24.04 Quick Start AMI plus Ubuntu's driver package avoids that.
- **The driver install fails on a fresh 24.04 AWS image without kernel headers.**
  `ubuntu-drivers install --gpgpu nvidia:580-server` pulled kernel `7.0.0-1014-aws`, and
  the module's post-install failed with `cannot open linker script file
  /usr/src/linux-headers-7.0.0-1014-aws/scripts/module.lds`. After rebooting into that
  kernel, `sudo apt-get install -y linux-headers-$(uname -r)` followed by
  `sudo apt-get install -f -y` finished it.
- **`nvidia-smi` as a normal user says it "couldn't communicate with the NVIDIA driver"**
  until `/dev/nvidia*` exist. `sudo nvidia-smi` creates them.
- **The company SSO role lacks `pricing:GetProducts`.** Public prices came from the JSON
  behind the EC2 pricing page
  (`https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/ec2/USD/current/ec2-ondemand-without-sec-sel/<Region name>/Linux/index.json`,
  gzip-compressed).
- **vLLM-Omni serves many unrelated routes** (robot policy, video, metrics) on the same
  port, which is why Caddy forwards only two paths.
- **Both of the builder's domains are live and delegated to Route 53**, checked with RDAP
  and `dig` against the delegated name servers.
- **Speech-to-text fits on the same server.** Qwen3-ASR has an official vLLM path
  (`vllm serve Qwen/Qwen3-ASR-1.7B`, OpenAI `/v1/audio/transcriptions`). Adding it means
  lowering the speech container's `--gpu-memory-utilization` from 0.9 to about 0.45. This
  is for the builder's separate voice-input project.

## Not Done Yet

- Stop and start the instance, then check `https://tts.jasenpan.com/health` returns 200
  on its own. The builder chose to do this last.
- Sydney leftovers, all free: key pair `tts-poc`, subnets `tts-poc-2a` and `tts-poc-2c`,
  security group `launch-wizard-4`, and `launch-wizard-5` if a failed launch created it.

## Open Questions

- [ ] G-002 is unchanged: which language model writes the brief.
