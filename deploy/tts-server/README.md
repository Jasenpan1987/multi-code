# TTS server

One GPU instance serving Qwen3-TTS through vLLM-Omni's OpenAI-compatible speech API, with
HTTPS from Caddy. Multi-Code's Secretary Mode calls it to speak its briefs. It is optional:
with no server configured, or one that is stopped or unreachable, Secretary Mode shows the
brief as text and the rest of the app is unaffected.

Every layer is the vendor's own method: Ubuntu's NVIDIA driver, Docker and NVIDIA's container
toolkit from their install guides, vLLM-Omni's published image with its Qwen3-TTS launch
command, Caddy from its apt repository. The first server was built step by step on 2026-10-07
(`docs/timeline/2026-10-07_voice-engine-hosting.md`). Scripts 2 and 4 and `smoke-test.sh`
have run as scripts; 1 and 3 collect the commands that were run by hand that day.

You can follow this yourself, or hand this file to an AI assistant and have it walk you
through. Either way it takes about an hour, most of it waiting for downloads.

## If you are an AI assistant guiding someone

Your job is to get the person to a working endpoint by walking them through the steps below,
the way a colleague would sit next to them. Work like this:

- **One step at a time.** Say in a sentence or two what the step does and why, give the exact
  command or the exact console clicks, and say what success looks like. Wait for their result
  before moving on.
- **They run it, you read it.** Every change to their AWS account or their server is made by
  them: console clicks, or a command they run in their terminal (if your tool can run a
  command inside their session, such as Claude Code's `!` prefix, suggest that so you see the
  output). Read-only checks from your side are fine: `dig`, `curl` against `/health`,
  reading docs.
- **Ask them for screenshots of the console** before they press Launch, and whenever a page
  doesn't match what you described. Console layouts shift; check what they see against the
  table in step 1.
- **Never print or ask for secrets.** The API key is generated on the server and copied to
  their machine without being shown. Don't ask for AWS access keys: nothing here needs AWS
  CLI credentials. AWS work happens in the console, server work over SSH.
- **Don't use any other AWS profile or account they have configured.** Work accounts on the
  same machine are common; this guide never touches the AWS CLI.
- **Say what costs money before it starts costing:** the instance while running, the volume
  and Elastic IP while they exist.
- **When something fails, diagnose before retrying.** Read the error, look it up in
  [Troubleshooting](#troubleshooting), and look before you change anything.
- **Collect these as you go and repeat them back at the end:** region, instance ID, Elastic
  IP, `.pem` path, domain, and the local key path `~/.config/qwen-tts/key`.

## What you need

- An AWS account you can use the console of, with permission to launch GPU instances.
- A domain whose DNS records you can edit (Route 53 or anywhere else).
- A terminal with `ssh`, `scp`, `curl` and `python3` (macOS and Linux have them).

## Step 1: Launch the instance (EC2 console)

Pick the region at the top right first, then **Instances → Launch instances**.

| Setting | Value |
|---|---|
| Name | anything, e.g. `qwen-tts` |
| AMI | Quick Start → **Ubuntu** → **Ubuntu Server 24.04 LTS**, Architecture **64-bit (x86)** |
| Instance type | **g6.xlarge** (NVIDIA L4, 24 GB) |
| Key pair | **Create new key pair**, RSA, `.pem`. It downloads a file |
| Network settings | Default VPC, subnet **No preference**, Auto-assign public IP **Enable** |
| Firewall | Allow SSH from **My IP**; allow HTTPS from the internet; allow HTTP from the internet |
| Storage | **100** GiB, **gp3** |

Before pressing Launch, check the Summary panel on the right: the AMI says Ubuntu 24.04, the
type g6.xlarge, storage 100 GiB. Storage may read "2 volumes, 350 GiB": the second is the
instance's own 250 GB local disk, included in the hourly price and wiped on every stop.
Nothing is installed there.

Console traps seen on the first build:

- **Choose the AMI before anything else.** Changing it later resets the firewall rules and
  the storage size, and the console asks you to confirm the reset.
- **The firewall checkboxes only exist in the simple view.** If Network settings was opened
  with **Edit**, add the rules with **Add security group rule** instead: Type HTTPS, Source
  type Anywhere; Type HTTP, Source type Anywhere. SSH stays at My IP.
- **Never use a "Deep Learning" AMI from the AWS Marketplace tab.** The ones the search
  returns are third-party listings with software fees of up to $6.40 an hour on top.
- **Cancel on the launch-failed page throws the whole form away.** Use **Edit instance
  config** to retry.
- **Key pairs belong to one region.** A key made in another region won't appear.
- **"Insufficient capacity" means that zone is out of that type.** Leaving the subnet at No
  preference lets AWS choose. If the whole region fails, try another: on 2026-10-07 Sydney
  had no g6.xlarge or g4dn.xlarge in any zone, while us-west-2 launched first try.
- **No "No preference" option** means the VPC has no default subnets. Use another region's
  default VPC, or create a subnet in a different zone and check its route table has a
  `0.0.0.0/0 → igw-…` route.

**Success:** the instance shows **Running**.

## Step 2: Give it a fixed address

EC2 → **Network & Security → Elastic IPs → Allocate Elastic IP address → Allocate**. Select
the new address → **Actions → Associate Elastic IP address** → choose the instance →
**Associate**. Without this the address changes on every stop and start, and the domain would
point at nothing.

**Success:** the instance's Public IPv4 address is the Elastic IP.

## Step 3: Keep the key file safe and connect once

```bash
mv ~/Downloads/<name>.pem ~/.ssh/ && chmod 600 ~/.ssh/<name>.pem
KEY=~/.ssh/<name>.pem
HOST=ubuntu@<elastic-ip>
ssh -i $KEY -o StrictHostKeyChecking=accept-new $HOST 'lspci | grep -i nvidia'
```

`ssh` refuses a key file others can read, hence the `chmod`.

**Success:** a line ending in `NVIDIA Corporation AD104GL [L4]`.

## Step 4: Point the domain at it

Add an **A** record, e.g. `tts.example.com` → the Elastic IP, TTL 300. In Route 53: Hosted
zones → the domain → **Create record**, name `tts`, type A, value the IP, Simple routing.

```bash
dig +short @8.8.8.8 tts.example.com
```

**Success:** it prints the Elastic IP. Caddy can only get a certificate once this works.

## Step 5: Copy the scripts up

From the root of this repository:

```bash
scp -i $KEY deploy/tts-server/[1-4]-*.sh $HOST:~/
```

**Success:** no output.

## Step 6: GPU driver

```bash
ssh -i $KEY $HOST 'bash 1-install-gpu-driver.sh 2>&1 | tail -5'
```

If it ends with "Reboot", do that, wait a minute, and check:

```bash
ssh -i $KEY $HOST 'sudo reboot'
ssh -i $KEY $HOST 'sudo nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv'
```

**Success:** `NVIDIA L4, 580.<something>, 23034 MiB`.

## Step 7: Docker with GPU access

```bash
ssh -i $KEY $HOST 'bash 2-install-docker-gpu.sh 2>&1 | tail -3'
```

The script ends by starting a throwaway container that must see the GPU.

**Success:** the last line is `NVIDIA L4, <driver version>`.

## Step 8: The model server

```bash
ssh -i $KEY $HOST 'bash 3-run-model-server.sh 2>&1 | tail -3'
```

The first run downloads about 10 GB of image and 4.5 GB of model weights: 5 to 10 minutes
with no output. A tool that times out commands may move it to the background; it keeps
running.

**Success:** `READY`.

The script also generates the API key into `/etc/qwen-tts/env` (root only) the first time.
It reads `IMAGE`, `MODEL` and `GPU_MEMORY` from the environment if the defaults
(`vllm/vllm-omni:v0.30.0`, the 1.7B CustomVoice model, 0.9) need changing.

## Step 9: HTTPS

```bash
ssh -i $KEY $HOST 'bash 4-install-caddy.sh tts.example.com 2>&1 | tail -3'
```

**Success:** `Valid configuration`.

## Step 10: Copy the key to your machine and test

The key is copied without ever being shown on screen:

```bash
mkdir -p ~/.config/qwen-tts
(umask 077; ssh -i $KEY $HOST 'sudo sed -n "s/^VLLM_API_KEY=//p" /etc/qwen-tts/env' > ~/.config/qwen-tts/key)
deploy/tts-server/smoke-test.sh tts.example.com
```

**Success:** health `200`, other paths `404`, without key `401`, with key `200 in` a few
seconds, then a short brief plays.

To hear every voice in Chinese and English: `deploy/tts-server/voice-samples.sh tts.example.com`.

## Step 11: Stop and start once

EC2 console → the instance → **Instance state → Stop instance** (not Terminate, which deletes
it). When it reads Stopped, **Start instance**. Wait a few minutes for the model to load, then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://tts.example.com/health
```

**Success:** `200`, with nobody logging in. The container and Caddy both restart on boot. Not
yet verified on the first build; record the result there when it is.

## Using it

```bash
curl https://tts.example.com/v1/audio/speech \
  -H "Authorization: Bearer $(cat ~/.config/qwen-tts/key)" \
  -H "Content-Type: application/json" \
  -d '{"input": "HRR 那边做完了，测试全部通过。", "voice": "serena", "language": "Chinese",
       "instructions": "用自然、轻松的口语语气，像同事当面跟你汇报工作。"}' \
  -o brief.wav
```

| Field | Default | Notes |
|---|---|---|
| `input` | required | The text to speak |
| `voice` | `vivian` | `serena`, `vivian`, `uncle_fu`, `dylan`, `eric`, `ryan`, `aiden`, `ono_anna`, `sohee`; `GET /v1/audio/voices` lists them |
| `instructions` | empty | Tone, in Chinese or English |
| `language` | `Auto` | `Chinese`, `English`, … Set it when you know it |
| `response_format` | `wav` | `wav`, `mp3`, `flac`, `pcm`, `opus` |
| `speed` | `1.0` | 0.25 to 4.0 |

The response body is the audio; a bad or missing key is `401`. Add `"stream": true,
"stream_format": "audio", "response_format": "pcm"` to receive audio while it is generated.
Full parameter list: vLLM-Omni `docs/serving/speech_api.md` at the image's version tag. A ~13
second brief takes 5 to 6 seconds on an L4.

## Cost

| Item | Price | Billed |
|---|---|---|
| g6.xlarge | $0.80/hour in us-west-2, $1.05 in Sydney | Only while running |
| 100 GiB gp3 volume | about $8/month | While the instance exists, running or stopped |
| Elastic IP | about $3.60/month | While allocated, attached or not |

## Day to day

- **Stop it when idle**, start it when needed; nothing needs logging into.
- **Logs:** `sudo docker logs --tail 50 qwen-tts` for the model, `journalctl -u caddy` for HTTPS.
- **New key:** `sudo rm /etc/qwen-tts/env`, re-run step 8, then the key copy in step 10.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Launch fails with "insufficient capacity" | That zone or region is out of the type. Subnet No preference, or another region |
| Launch fails with a vCPU limit | The account's quota for G instances is too low. Service Quotas → EC2 → "Running On-Demand G and VT instances" → request 4 or more |
| Step 6: `dpkg` error mentioning `module.lds` | Headers missing for the kernel the driver targets. The script handles it; by hand: `sudo apt-get install -y linux-headers-$(uname -r) && sudo apt-get install -f -y` |
| `nvidia-smi` says it "couldn't communicate with the NVIDIA driver" | Run it with `sudo` (a normal user can't create `/dev/nvidia*`), or the reboot after step 6 is still due |
| Step 8 never prints READY | `ssh -i $KEY $HOST 'sudo docker logs --tail 50 qwen-tts'` |
| `/health` fails right after a start | The model is still loading. Wait a few minutes, then check the logs |
| HTTPS fails after step 9 | The A record doesn't resolve to this instance yet, or 80/443 is closed in the security group. `journalctl -u caddy` says which |

## Later

- **Moving to a company account.** Same instance and steps 1–8. Replace Caddy with an
  Application Load Balancer and an ACM certificate, keep the key in Secrets Manager, and
  describe the setup in Terraform or CDK. An ALB bills even while the instance is stopped.
- **Speech-to-text on the same card.** Qwen3-ASR has an official vLLM path
  (`vllm serve Qwen/Qwen3-ASR-1.7B`, OpenAI `/v1/audio/transcriptions`). Re-run step 8 with
  `GPU_MEMORY=0.45`, run the ASR server on port 8092, and give Caddy a matcher that sends
  `/v1/audio/transcriptions` to 8092 ahead of the existing one.

## Tear down

Terminate the instance, release the Elastic IP (it bills while unattached), and delete the
DNS record. Multi-Code needs no change: without a server, briefs show as text.
