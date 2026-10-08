# Speech-to-text server plan

A plan, not a record: nothing here has been run yet. Researched 2026-10-08 against vLLM
v0.30.0 / v0.31.0, vLLM-Omni v0.30.0 and the model cards as they stood that day. Sources
are numbered [S1]… at the end. **Inference** marks a conclusion of mine that no document
states.

It adds speech-to-text next to the existing TTS on the g6.xlarge in us-west-2
(`deploy/tts-server/README.md`), for Sounds Good, the voice-input app. Same rules as the
TTS: every layer is the vendor's documented method, with the doc cited beside the command.

**Data boundary.** Sounds Good's intent says real recordings stay in the company's own AWS
account in an Australian region. This personal server is at most a test bed for
non-sensitive clips (synthetic speech, scripted test sentences), pending the builder's
decision. The steps are written to carry over to a company account in ap-southeast-2; what
changes there is in [Moving to the company account](#moving-to-the-company-account-ap-southeast-2).

## Deployed 2026-10-08

Steps 1–9 ran on the personal test bed; step 10 is deferred and step 11 (stop and start)
is still to do. What differed from the plan, and what was measured:

- **Before:** the TTS held 22,006 of 23,034 MiB, its stage 1 started with
  "Capping requested memory to available free memory (1.44 GiB)": the per-stage reading
  below was right.
- **TTS at 0.25 / 0.15:** 7,278 MiB idle, **7,280 MiB peak** over four long briefs, two of
  them at once (all `200`, 8–9.6 s each). Stage 0 KV cache 1.48 GiB. It reserves up front
  and doesn't grow, so the "transient peaks" margin wasn't needed.
- **Qwen3-ASR at 0.30 failed** with "No available memory for the cache blocks". It runs at
  **0.50**: 4.36 GiB of KV cache, 40,816 tokens, 9.96× concurrency at 4,096 tokens; the card
  at 17,735 of 23,034 MiB. Host RAM: 5.7 GiB available of 15 GiB, no swap.
- **Step 7:** Qwen's sample came back exactly "甚至出现交易几乎停滞的情况。" in 0.24 s on the
  server.
- **Step 9 from the Mac (Australia → us-west-2, 24 kHz WAV, a new TLS connection per call):**
  3 s clip 1.3 s, 8 s 2.0 s, 10 s English 2.0 s, 24 s 3.0 s. Errors on TTS-spoken clips: "PR"
  → "片儿" in the short clip, "后天的" → "昊天呢", "UVAP" → "U V A P" in the long clip, "pass"
  → "passed". English terms stayed Latin, Chinese stayed Simplified. A `prompt` of
  "UVAP, Multi-Code" changed nothing on the 8 s clip. Reproduce: `deploy/asr-server/smoke-test.sh`.
- **Caddy:** the whole config is `deploy/asr-server/Caddyfile`, sent with
  `ssh … 'sudo tee /etc/caddy/Caddyfile' < deploy/asr-server/Caddyfile` (pasting the multi-line
  heredoc in step 8 got cut off). The original is on the server as
  `/etc/caddy/Caddyfile.before-asr`.

## Recommendation

**Builder's decision, 2026-10-08: deploy Qwen3-ASR-1.7B only.** Fun-ASR-Nano-2512 (step 10,
the `funasr` DNS record and Caddy block) is **deferred**: the enforced hotword list it was
wanted for turned out not to exist in its open checkpoint, and the rest isn't worth an older
vLLM, fp32 unvalidated on an L4, and swapping the memory slot. If Qwen3-ASR falls short in
testing, other options get looked at then, not necessarily Fun-ASR. The Fun-ASR material
below is kept for that day.

- **Model:** Qwen3-ASR-1.7B as the always-on engine, at `asr.jasenpan.com`. (Deferred:
  Fun-ASR-Nano-2512 as a comparison engine at `funasr.jasenpan.com`, taking turns with
  Qwen3-ASR in the same memory slot.)
- **Image:** upstream vLLM's published `vllm/vllm-openai:v0.30.0` plus the `vllm[audio]`
  layer that vLLM's Docker docs tell you to add, built on the server (two-line
  Dockerfile). Not vLLM-Omni. For Fun-ASR, the same recipe on `v0.27.1`, the only version
  its vLLM packaging is validated on.
- **Memory split of the 24 GB L4:** TTS talker stage 0.25, TTS code2wav stage 0.15, one ASR
  server 0.30, about 0.30 left unreserved for CUDA contexts and the TTS's transient peaks.
  **As deployed: the ASR at 0.50**, since 0.30 left no KV cache (see Deployed, above).
  The TTS share is set per stage with `--stage-overrides`, **not** by lowering
  `--gpu-memory-utilization` to 0.45 as the hosting notes say (that flag is applied to each
  TTS stage separately; see [Memory](#two-models-on-one-l4)).

Why: Qwen3-ASR's own README sends deployment to plain vLLM (`vllm serve Qwen/Qwen3-ASR-1.7B`,
OpenAI `/v1/audio/transcriptions`) [S1][S4], vLLM lists it as a native transcription model
since v0.16.0 [S5][S6], and v0.30.0 is the vLLM the TTS image is built on, so the base
layers are already on disk [S19]. Fun-ASR-Nano has an official vLLM-native packaging with
the OpenAI endpoint and a `hotwords` field [S27][S8], which is the hard-vocabulary
experiment Sounds Good wants to run, but it is validated only on vLLM 0.27.1 in float32
[S27]. All three models at once do not fit on one L4 with any margin (table below), so the
two ASR models share one slot.

### Sounds Good's requirements against this plan

| Requirement (from Sounds Good) | Status here |
|---|---|
| Push-to-talk, transcribe after key release | Met: batch `POST /v1/audio/transcriptions` |
| Clips under 30 s; tests 3–60 s | Up to 30 s is one pass; 31–60 s is split into two chunks transcribed in parallel [S9] |
| Text within 3 s of release, rewrite included | Uncertain for 30 s clips on an L4 (see [Latency](#latency-on-an-l4-inference-to-be-measured)); step 9 measures; Qwen3-ASR-0.6B is the fallback |
| Pure English and mid-sentence Chinese-English, English terms in Latin script | Both models are built for zh/en; no vendor guarantee for either; step 9 checks with synthetic clips |
| Simplified, not Traditional | Not documented for either model; step 9 checks |
| Punctuation not important; no timestamps or speakers | Both emit punctuation; the `json` response carries text only |
| Hard custom dictionary | Neither server enforces one: Fun-ASR's `hotwords` and Qwen3-ASR's `prompt` are both prompt text. Enforce spellings in Sounds Good's own rewrite step |
| Recordings stay in the company's AWS account, Australia | Not on this server; test bed for non-sensitive clips only. See the company section |

### Memory plan

L4 as `nvidia-smi` reports it on this server: 23034 MiB, about 22.5 GiB. A share reserves
`share × total` of it [S14].

| Process | Share | Reserved | Weights | Rest of the share |
|---|---|---|---|---|
| TTS stage 0, talker | 0.25 | 5.6 GiB | 3.6 GiB (`model.safetensors` 3.83 GB) [S26] | ~2 GiB: activations, CUDA graphs, KV at 112 KiB/token |
| TTS stage 1, code2wav | 0.15 | 3.4 GiB | ~0.5–0.6 GiB (`speech_tokenizer` 0.68 GB) [S26][S24] | activations; the vendor's 24 GB profile offers 0.15 for this stage [S24] |
| ASR slot: Qwen3-ASR-1.7B, bf16 | 0.30 | 6.7 GiB | 4.4 GiB (4.70 GB of safetensors) [S2] | ~2.3 GiB; KV at 112 KiB/token, so roughly 1–1.5 GiB ≈ 9–13k tokens (**inference**) |
| ASR slot, alternate: Fun-ASR-Nano, fp32 | 0.30 | 6.7 GiB | ~3.7 GiB (1.97 GB file, bf16, doubled for fp32) [S27] | ~3 GiB; KV at 224 KiB/token in fp32 (**inference**) |
| Unreserved | ~0.30 | ~6.7 GiB | | CUDA context per GPU process (~0.5 GiB each, **inference**), TTS transient peaks |

KV per token is `2 × layers × KV heads × head_dim × bytes`: 2 × 28 × 8 × 128 × 2 = 112 KiB
for both Qwen3-ASR-1.7B's decoder and the TTS talker [S2][S26], 224 KiB for Fun-ASR-Nano's
Qwen3-0.6B decoder in fp32 [S27]. A 30 s request is about 390 audio tokens for Qwen3-ASR
(13 tokens per second of audio, from vLLM's `_get_feat_extract_output_lengths`) [S10],
plus prompt and output, well under 1,000 tokens.

**Can Qwen3-TTS + Qwen3-ASR-1.7B + Fun-ASR-Nano all run at once?** Not safely. With the
validated Fun-ASR setup the reservations add up to 0.40 + 0.30 + 0.30 = 1.00 of the card,
before CUDA contexts and the TTS's peaks. Squeezing (Qwen3-ASR at 0.25, Fun-ASR in bf16 at
0.15) reaches about 0.80 reserved, which leaves under 2 GiB for three or four CUDA contexts
and a code2wav peak the vendor measured at several GiB above its reservation [S24], and it
takes Fun-ASR off its validated dtype. **Best two of three:** TTS + Qwen3-ASR always on;
Fun-ASR swaps in for Qwen3-ASR for comparison runs (a minute or two, weights cached). For a
side-by-side session, stop the TTS instead (`docker stop qwen-tts`; Multi-Code then shows
briefs as text) and run both ASR servers at 0.30 each.

## What the docs say

### Qwen3-ASR

- **Models.** Qwen3-ASR-1.7B and Qwen3-ASR-0.6B, Apache-2.0, released 2026-01-29; 30
  languages plus 22 Chinese dialects, language ID included, "Offline / Streaming", single
  input up to 20 minutes [S1][S3]. The 0.6B is the efficiency model (TTFT 92 ms, 2,000×
  real time at concurrency 128 on an unnamed GPU with vLLM v0.14.0) [S3].
- **Serving path.** "vLLM officially provides day-0 model support… `vllm serve
  Qwen/Qwen3-ASR-1.7B`… This model is also supported on vLLM with OpenAI transcription API"
  [S1][S4]. Those pages still say to install a nightly wheel, because they were written on
  release day; the architecture shipped in the v0.16.0 release (#33312) [S5] and is in the
  v0.30.0 and v0.31.0 transcription tables [S6]. vLLM ships its own config and processor
  for it [S10], and the recipe's command has no `--trust-remote-code` [S4].
- **Image.** vLLM's published image is `vllm/vllm-openai:<tag>` [S13]. Its docs say
  "Optional dependencies are not included", and give the fix: a Dockerfile `FROM
  vllm/vllm-openai:<v>` with `RUN uv pip install --system vllm[audio]==<v>`, "Make sure the
  version of vLLM matches the base image" [S13]. The transcription API needs that extra
  [S7]; in v0.30.0 it is `av`, `scipy`, `soundfile`, `soxr`, `mistral_common[audio]`, and
  `vllm/multimodal/audio.py` loads them as placeholders when absent [S13].
- **Why v0.30.0.** `vllm/vllm-omni:v0.30.0` is built `FROM vllm/vllm-openai:v0.30.0`
  [S19], so the ASR image reuses the TTS image's layers (**inference**: the pull should say
  "Already exists" for nearly all of them). Between v0.30.0 and v0.31.0 the Qwen3-ASR and
  FunASR model files changed only in internal plumbing (type names, the multimodal
  processor interface); prompt building, hotword handling and the transcription request
  are the same (my diff of the two tags), so v0.31.0 offers nothing this plan needs.
- **One image for both TTS and ASR?** Not documented. vLLM-Omni v0.30.0's model list has no
  Qwen3-ASR [S25], and neither Qwen nor vLLM-Omni describes serving it from the Omni image.
  It would probably work, since that image contains vLLM 0.30.0, but that is the kind of
  shortcut the conventions rule out, so the plan doesn't take it. The documented image gets
  most of the benefit anyway through the shared layers.
- **Qwen's other offerings, not used:** `qwen-asr-serve` is "a wrapper around `vllm
  serve`", and `qwenllm/qwen3-asr` is an interactive development container for the
  `qwen-asr` package [S1]. Neither is the deployment path the README gives.
- **Flags this server needs** (both **inference** from vLLM's behaviour, not from a
  Qwen doc): `--gpu-memory-utilization 0.30`, because the default is 0.92 [S14]; and
  `--max-model-len 4096`, because the model's 65,536-token default needs 7.0 GiB of KV
  cache for one sequence, which does not fit a 0.30 share, and vLLM refuses to start when
  the KV cache can't hold one max-length sequence. `--max-model-len auto` is the documented
  alternative [S15]. vLLM splits audio into 30 s chunks anyway (below), so 4096 is ample.

### Fun-ASR-Nano-2512

- **Model.** 0.8B (0.2B SenseVoice-style encoder + Qwen3-0.6B decoder), Chinese with 7
  dialects and 26 accents, English, Japanese; Apache-2.0 on the card [S28][S32]. The
  31-language variant is Fun-ASR-MLT-Nano-2512; FunAudioLLM publishes a `-vllm` packaging
  only for the base Nano (https://huggingface.co/FunAudioLLM).
- **Official serving paths.** Two, both from the vendor:
  1. **vLLM's OpenAI server** with the official packaging `FunAudioLLM/Fun-ASR-Nano-2512-vllm`
     ("the official vLLM-native packaging"; tensors bitwise equal to the original
     checkpoint). The card's "validated path": `pip install "vllm==0.27.1"`, then `vllm
     serve FunAudioLLM/Fun-ASR-Nano-2512-vllm --revision vllm-0.27.1-20260830
     --served-model-name fun-asr-nano --dtype float32 --gpu-memory-utilization 0.40
     --enforce-eager`. Validated on one H100 80 GB; "Other vLLM releases, accelerators,
     quantizations… require separate validation" [S27]. vLLM lists the architecture
     (`FunASRForConditionalGeneration`) since v0.17.0 [S5][S6].
  2. **FunASR's own scripts** `serve_vllm.py` (HTTP `/asr`, an OpenAI-style
     `/v1/audio/transcriptions`, and a WebSocket) and `serve_realtime_ws.py` (streaming),
     run from a clone of the FunASR repository after `pip install funasr vllm` [S30]. No
     published image, no API key option documented. Not chosen: it would mean building a
     Python environment by hand, and its OpenAI endpoint's documented fields don't include
     hotwords (only `/asr` does) [S30].
- **Plan choice:** path 1 on `vllm/vllm-openai:v0.27.1` + `vllm[audio]==0.27.1`, with the
  card's flags. Two additions for this card, both **inference**: `--gpu-memory-utilization
  0.30` instead of 0.40 (0.40 of an H100 is 32 GB; of an L4 it is 9 GiB, which the TTS
  can't spare), and `--max-model-len 4096` (the 40,960-token default needs 8.75 GiB of
  fp32 KV for one sequence). Running it on the v0.30.0 image instead would save a ~9 GB
  download, but that is a version the vendor hasn't validated; if the builder wants that
  trade, the card's pinned sample is the acceptance test.
- **Hotwords.** vLLM's transcription request has a `hotwords` string field [S8]. For
  Fun-ASR, vLLM puts it in the prompt as `热词列表：[<hotwords>]` [S11]; FunASR's own code
  builds the same prompt from a list joined with `", "` [S31], so send `"UVAP, Multi-Code"`.
  This is a prompt, not a hard constraint. The technical report's hotword method retrieves
  candidates from a CTC hypothesis (RAG) before the LLM [S32], but the Hugging Face
  checkpoint the vLLM packaging comes from (revision `272c57b…`) is "the older text-only
  artifact… with no CTC tensors" [S29][S27], so through vLLM only the prompt part applies.
  The report's recall figures (0.95–1.00, Table 6) and code-switching WERs (Table 5: 1.55 /
  4.49 offline) are stated for "Fun-ASR"; I could not confirm they cover Nano [S32].
- **Language.** vLLM's Fun-ASR prompt ignores `language`; without one it logs a warning and
  assumes `en`, which only affects how >30 s chunks are joined [S11][S9].

### The API (both servers)

From vLLM v0.30.0 [S7][S8][S9][S12]:

- `POST /v1/audio/transcriptions`, `multipart/form-data`. Fields: `file` (required),
  `model` (optional; if sent it must equal the served name, else 404), `language` (ISO-639-1,
  optional), `prompt`, `hotwords`, `response_format` (`json` default, `text`,
  `verbose_json`, `diarized_json`), `temperature` (default 0), `stream`, plus sampling
  extras (`top_p`, `seed`, `max_completion_tokens`, …).
- Formats: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm. Limits: 25 MB upload
  (`VLLM_MAX_AUDIO_CLIP_FILESIZE_MB`), 600 s decoded (`VLLM_MAX_AUDIO_DECODE_DURATION_S`).
  Audio is resampled to 16 kHz mono.
- Response (`json`): `{"text": "…", "usage": {"type": "duration", "seconds": 7}}`.
- Audio longer than the model's 30 s window (`chunk_length: 30` in both models'
  `preprocessor_config.json`) [S2][S27] is cut at the quietest point near each 30 s mark,
  the chunks are transcribed concurrently, and the texts are joined with a space, or with
  nothing when `language` is `zh` or `ja` [S9].
- `verbose_json` needs segment timestamps: refused for Qwen3-ASR, allowed for Fun-ASR
  [S10][S11]. Sounds Good needs neither.
- Qwen3-ASR: `prompt` becomes the system turn, the same "context" the Qwen SDK takes
  (`_build_messages`), with chat control tokens stripped; `language` forces `language
  Chinese<asr_text>`, else the model detects it; `hotwords` is ignored [S10][S1]. The
  report: "the model learns to utilize the context tokens inside the system prompt as
  background knowledge" [S3].
- Auth: `VLLM_API_KEY` guards paths under `/v1`, `/v2`, `/inference`, `/cohere`, WebSockets
  included; `/health` is open; vLLM warns that `/invocations` "exposes the same inference
  capabilities as `/v1`" and stays unauthenticated [S16]. Hence Caddy's path allowlist.
- Request logging is off by default (`enable_log_requests: bool = False` in v0.30.0's
  `vllm/engine/arg_utils.py`), so transcripts shouldn't appear in `docker logs`
  (**inference** from the default; not checked on a running server).

**Language support.** Qwen3-ASR: Chinese and English are most of its training data [S3];
punctuation appears in the vendor samples. Neither Qwen's README nor its report gives a
mid-sentence Chinese-English benchmark, and neither says whether Mandarin comes out in
Simplified or Traditional script. Fun-ASR was trained on synthesized Chinese-English
code-switched speech built around 40k English keywords [S32], which suggests English
terms stay in Latin script, but no document guarantees it. Both questions are in the test
below and in Open questions.

### Streaming

- `stream=true` on `/v1/audio/transcriptions` returns server-sent events
  (`transcription.chunk` objects, then `data: [DONE]`) [S8][S9]. The upload has to finish
  first, so for push-to-talk it only overlaps text delivery with decoding.
- **Realtime:** `ws://host/v1/realtime`, base64 PCM16 at 16 kHz mono,
  `input_audio_buffer.append` / `commit`, `transcription.delta` / `done` events [S7].
  Supported models: Voxtral Realtime and "Qwen3-ASR Realtime" (example `Qwen/Qwen3-ASR-0.6B`),
  which needs `--hf-overrides '{"architectures":["Qwen3ASRRealtimeGeneration"]}'` [S6]. In
  vLLM's code it transcribes fixed 5 s segments independently, with no system prompt (so no
  context biasing) and at most 64 tokens each [S10]. Fun-ASR has no vLLM realtime; FunASR's
  own WebSocket server does streaming with hotwords [S30].
- **Plan:** batch after key release, as Sounds Good says is enough. Whether batch meets the
  3 s budget for 30 s clips on an L4 is doubtful (next section); measure in step 9 before
  deciding.

### Latency on an L4 (inference, to be measured)

Decoding a small model at batch size 1 is bound by memory bandwidth: every output token
reads all decoder weights once. The L4 has 300 GB/s [S34].

| Model | Weights read per token | Ceiling | A 30 s clip (~100–110 output tokens) |
|---|---|---|---|
| Qwen3-ASR-1.7B, bf16 | ~3.4 GB | ~88 tokens/s | ~1.5–2 s on the GPU |
| Qwen3-ASR-0.6B, bf16 | ~1.2 GB | ~250 tokens/s | ~0.5–0.8 s |
| Fun-ASR-Nano, fp32, eager | ~2.4 GB | ~125 tokens/s, less without CUDA graphs | ~1–2 s |

Add upload and round trip from Australia to us-west-2 (~0.3–0.8 s for a 1 MB WAV; much less
as m4a/ogg). So the 1.7B on an L4 probably cannot leave room for the LLM rewrite inside
3 s on a 30 s clip, while 5–15 s clips should be fine. If step 9 confirms that, the
options are, in order of how little they change: Qwen3-ASR-0.6B in the same slot; Sounds
Good sending finished segments while the key is held (a client change); the realtime
endpoint with its limits; a faster GPU.

### Two models on one L4

- **Upstream vLLM:** `gpu_memory_utilization` "is a per-instance limit… if you have two
  vLLM instances running on the same GPU, you can set the GPU memory utilization to 0.5 for
  each instance" [S14]. At start, an instance refuses to run if free memory is below
  `share × total` ("Free memory on device … is less than desired GPU memory utilization")
  [S14]. Inside its share it profiles weights, peak activations and non-torch memory, then
  preallocates the rest as KV cache [S14].
- **vLLM-Omni, per stage:** the TTS is two engines on GPU 0, and `qwen3_tts.yaml` gives each
  `gpu_memory_utilization: 0.3` [S20]. "When multiple stages share the same GPU, you must
  ensure the sum of their `gpu_memory_utilization` values doesn't exceed 1.0" [S22].
  Explicit global CLI flags rank above the YAML, and a global flag lands in every stage:
  the documented example applies a global `--max-model-len` to all stages [S21], and the
  code copies each explicitly passed CLI key into every stage's overrides [S23].
  `--stage-overrides '{"0": {...}, "1": {...}}'` is the per-stage knob and wins over
  global flags [S21].
- **So today's TTS** (`--gpu-memory-utilization 0.9`) most likely asks for 0.9 in both
  stages. It starts anyway because vLLM-Omni's `request_memory_tolerant` caps a stage's
  request to free memory instead of failing ("expected when multiple Omni stages share a
  GPU") [S23]. Result: the TTS takes nearly the whole card. **Inference** from docs and
  code; step 1 checks it on the server.
- **Lowering it to 0.45** would ask for 0.45 per stage, up to 0.9 of the card again,
  leaving no room for ASR. Hence `--stage-overrides` with 0.25 and 0.15 and no global
  flag. The vendor's own 24 GB profile (RTX 4090, the 0.6B TTS) runs both stages at 0.3,
  ~13.5 GiB idle, and gives a 0.15 / 0.15 override for ~5 GiB idle and ~10 GiB inference
  peak [S24]. The 1.7B talker's weights are 1.7 GiB larger than the 0.6B's, hence 0.25 for
  stage 0.
- **Risks.**
  - *Order at start.* If the TTS is ever restarted with its old command (e.g. `bash
    3-run-model-server.sh` as it stands), it grabs the card and the ASR server can't start
    (strict check), or, if the ASR started first, the TTS stages are capped and may fail.
  - *Simultaneous boot.* Docker starts every `unless-stopped` container when the daemon
    starts. vLLM's profiling "assume[s] that the other processes using the same GPU did not
    change their memory usage during the profiling" and asserts if free memory went up
    meanwhile [S14]. Two servers profiling at the same moment could trip that, or one could
    count the other's allocations as its own and get a smaller KV cache. The restart policy
    retries a crashed container [S36], so it should settle, but this is unverified; step 11
    checks it.
  - *Peaks beyond reservations.* The vendor's 24 GB profile shows the TTS peaking ~5 GiB
    above its idle footprint [S24]. Step 3 measures the real peak.
  - *Latency under overlap.* Processes on one GPU share its compute and bandwidth (without
    MPS they are time-sliced [S40]), so a transcription that lands during a TTS synthesis
    will be slower. One user rarely does both at once (**inference**).

## Alternatives

| Option | Languages | Streaming | Beside the TTS on the L4 | Official serving path |
|---|---|---|---|---|
| **Qwen3-ASR-1.7B** (chosen) | 30 + 22 dialects, zh/en strongest [S3] | vLLM realtime, 5 s segments, no context [S6][S10] | Yes, 0.30 | vLLM ≥ 0.16, `vllm/vllm-openai` + `vllm[audio]` [S1][S5][S13] |
| Qwen3-ASR-0.6B | Same | The realtime example model [S6] | Yes, ~0.15 | Same; the latency fallback |
| **Fun-ASR-Nano-2512** (compare) | zh (+dialects), en, ja [S28] | FunASR's own WebSocket server only [S30] | Yes, 0.30, but not with Qwen3-ASR at the same time | `Fun-ASR-Nano-2512-vllm` on vLLM 0.27.1 [S27] |
| Whisper large-v3 / large-v3-turbo | Multilingual; mid-sentence zh-en reported to break (it translates) [SG] | No vLLM realtime [S6] | Yes (1.6 GB of weights for turbo) [S41] | vLLM `WhisperForConditionalGeneration` [S6]; prompt only, no hotwords |
| SenseVoice-Small | zh, en, yue, ja, ko [S42] | FunASR runtime | Yes | No vLLM support ("✗" in Fun-ASR's guide) [S30]; FunASR model licence, needs legal review [S42][SG] |
| NVIDIA Parakeet 0.6b CTC Mandarin English (`parakeet-ctc-0.6b-zh-cn`) | Mandarin + English code-switch [S33] | Yes, streaming and offline [S33] | Yes, 4.7–5.6 GB per single-mode profile; L4 listed [S33] | Riva ASR NIM: `/v1/audio/transcriptions` (file, language, model, response_format; no prompt), gRPC, realtime WS; requires an NVIDIA AI Enterprise licence to self-host [S33] |
| Voxtral Mini / Realtime | No Chinese [SG] | Voxtral Realtime [S6] | Yes | vLLM [S6]; English-only fallback |
| GLM-ASR-Nano-2512 | zh/en | No | Yes | vLLM [S6]; behind Fun-ASR-Nano on the vendor's industry sets (26.13 vs 16.72 avg WER) [S28] |

[SG] = Sounds Good's research, `/Users/jasenpan/code/apra/sounds-good/research/2026-10-07-speech-to-text.md`.

## Steps

**Superseded by [`README.md`](README.md)**, the how-to that ran on 2026-10-08, with its
scripts. These are the plan as written before deployment; where they differ (the ASR at 0.50,
not 0.30; the Caddyfile sent as a file), the README and "Deployed 2026-10-08" above are right.

**Test material is made up.** Everything sent to this server during the POC is non-sensitive:
the test clips are spoken by the TTS server from invented sentences, and the dictionary term
used throughout, "UVAP", is an invented acronym standing in for a real project name. Never put
real internal names, recordings or dictionary entries into these commands while the server
sits in the personal account (Sounds Good, `decisions/2026-10-08-asr-test-bed.md`).

From the root of this repository on the Mac, with `KEY` and `HOST` set as in
`deploy/tts-server/README.md` step 3:

```bash
KEY=~/.ssh/<name>.pem
HOST=ubuntu@<elastic-ip>
```

Multi-line server commands are sent as `ssh -i $KEY $HOST 'bash -s' <<'EOF' … EOF`, so
they run on the server exactly as written. Nothing here touches the AWS CLI.

### Step 1: Look before changing anything (read-only)

```bash
ssh -i $KEY $HOST 'bash -s' <<'EOF'
df -h /
sudo docker system df
sudo nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
sudo nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader
sudo docker logs qwen-tts 2>&1 | grep -E "Available KV cache memory|Capping requested memory" | tail -4
EOF
```

**Success:** you have the free disk space (Qwen3-ASR needs ~5 GB of weights plus a small
image layer; the deferred Fun-ASR would need ~2 GB of weights plus a ~9 GB compressed image
[S18]), the TTS's current GPU use, and whether its log shows "Capping requested memory".
GPU use near 22,000 MiB and a capping line confirm the per-stage reading above.

### Step 2: DNS records

Route 53 → Hosted zones → `jasenpan.com` → **Create record**: name `asr`, type A, value the
Elastic IP, TTL 300, Simple routing [S37]. (The `funasr` record is deferred with step 10.)
The security group already allows 80 and 443; the model ports stay on 127.0.0.1, so nothing
changes there.

```bash
dig +short @8.8.8.8 asr.jasenpan.com
```

**Success:** it prints the Elastic IP. Caddy needs this before it can get certificates
[S35].

### Step 3: Give the TTS a fixed share, per stage

Same command as today with `--gpu-memory-utilization 0.9` replaced by per-stage values
[S21][S24].

```bash
ssh -i $KEY $HOST 'bash -s' <<'EOF'
set -euo pipefail
sudo docker rm -f qwen-tts
sudo docker run -d --name qwen-tts --restart unless-stopped --runtime nvidia --gpus all --ipc=host \
  --env-file /etc/qwen-tts/env \
  -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
  -p 127.0.0.1:8091:8091 \
  vllm/vllm-omni:v0.30.0 \
  vllm-omni serve Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice \
    --deploy-config /app/vllm-omni/vllm_omni/deploy/qwen3_tts.yaml \
    --host 0.0.0.0 --port 8091 --trust-remote-code --omni \
    --stage-overrides '{"0": {"gpu_memory_utilization": 0.25}, "1": {"gpu_memory_utilization": 0.15}}'
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null localhost:8091/health; then echo READY; break; fi
  sleep 10
done
sudo nvidia-smi --query-gpu=memory.used --format=csv,noheader
sudo docker logs qwen-tts 2>&1 | grep -E "Available KV cache memory" | tail -2 || true
EOF
```

Then measure the peak while the TTS works: in a second terminal start

```bash
ssh -i $KEY $HOST 'timeout 120 sudo nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -lms 200 | sort -n | tail -1'
```

and in the first run `deploy/tts-server/voice-samples.sh tts.jasenpan.com`.

**Success:** `READY`; stage 0 logs a positive KV cache size; idle use roughly 7–10 GiB; the
voice samples all return `200`; peak at most ~14,500 MiB (so that peak + an ASR share of
6.7 GiB + its context stays under ~22,000 MiB). If stage 0 fails with a KV cache error,
raise it to 0.28. If the peak is higher, lower the ASR share in step 6 to match, or raise
the question before going on. To undo: `ssh -i $KEY $HOST 'bash 3-run-model-server.sh'`
restores the old setup (only with no ASR container running).

Afterwards, `deploy/tts-server/3-run-model-server.sh` and its README still describe the old
flag; update them once this is settled (not part of this plan).

### Step 4: The ASR key

A separate key, so Sounds Good never holds the TTS key. Both ASR containers read this
file. The two extra lines turn off vLLM's anonymous usage reporting [S17].

```bash
ssh -i $KEY $HOST 'bash -s' <<'EOF'
set -euo pipefail
if ! sudo test -f /etc/asr/env; then
  sudo install -d -m 700 /etc/asr
  printf 'VLLM_API_KEY=%s\nVLLM_NO_USAGE_STATS=1\nDO_NOT_TRACK=1\n' "$(openssl rand -hex 32)" \
    | sudo tee /etc/asr/env >/dev/null
  sudo chmod 600 /etc/asr/env
fi
sudo cut -d= -f1 /etc/asr/env
EOF
```

**Success:** it prints the three variable names and no values.

### Step 5: Build the ASR image

vLLM's documented way to add the audio extra to its image [S13]:

```bash
ssh -i $KEY $HOST 'bash -s' <<'EOF'
set -euo pipefail
sudo docker pull vllm/vllm-openai:v0.30.0
sudo docker run --rm --entrypoint python3 vllm/vllm-openai:v0.30.0 -c 'import vllm; print(vllm.__version__)'
sudo docker build -t asr-vllm:v0.30.0 - <<'DOCKERFILE'
FROM vllm/vllm-openai:v0.30.0
RUN uv pip install --system "vllm[audio]==0.30.0"
DOCKERFILE
EOF
```

**Success:** the pull reports most layers "Already exists" (shared with the TTS image
[S19]); the version line is exactly `0.30.0` (if not, stop: the pin must match the base
image [S13]); the build installs `av`, `soundfile`, `soxr`, `scipy` and mistral-common's
audio parts, and does not reinstall `torch` or `vllm`.

### Step 6: Run Qwen3-ASR

The vendor command [S1][S4] in vLLM's documented container form [S13], with this card's
share and length limit, the compile-cache volume from vLLM's Docker docs [S13], and the
TTS's conventions: its own key file, `--restart unless-stopped`, bound to 127.0.0.1.

```bash
ssh -i $KEY $HOST 'bash -s' <<'EOF'
set -euo pipefail
sudo docker rm -f qwen-asr >/dev/null 2>&1 || true
sudo docker run -d --name qwen-asr --restart unless-stopped --runtime nvidia --gpus all --ipc=host \
  --env-file /etc/asr/env \
  -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
  -v qwen-asr-vllm-cache:/root/.cache/vllm \
  -p 127.0.0.1:8092:8000 \
  asr-vllm:v0.30.0 \
  --model Qwen/Qwen3-ASR-1.7B \
  --gpu-memory-utilization 0.50 \
  --max-model-len 4096
for _ in $(seq 1 90); do
  if curl -sf -o /dev/null localhost:8092/health; then echo READY; break; fi
  sleep 10
done
sudo docker logs qwen-asr 2>&1 | grep -E "Available KV cache memory|Maximum concurrency" | tail -2 || true
sudo nvidia-smi --query-gpu=memory.used --format=csv,noheader
EOF
```

The first run downloads 4.7 GB of weights [S2] and compiles; expect 5 to 10 minutes.

**Success:** `READY`; the log shows about 1 GiB or more of KV cache and a maximum
concurrency for 4,096-token requests of 2× or more; total GPU use roughly 14–17 GiB. If it
exits with "Free memory on device … is less than desired", the TTS is still holding the
card: back to step 3.

### Step 7: Test it on the server

Qwen's README sample [S1]; the README's forced-aligner example gives its text as
"甚至出现交易几乎停滞的情况。".

```bash
ssh -i $KEY $HOST 'bash -s' <<'EOF'
set -euo pipefail
curl -sfL -o /tmp/asr_zh.wav https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-ASR-Repo/asr_zh.wav
sudo bash -c '. /etc/asr/env; curl -s -w "\n%{http_code} in %{time_total}s\n" localhost:8092/v1/audio/transcriptions \
  -H "Authorization: Bearer $VLLM_API_KEY" -F file=@/tmp/asr_zh.wav -F model=Qwen/Qwen3-ASR-1.7B'
EOF
```

**Success:** `{"text":"甚至出现交易几乎停滞的情况。","usage":{"type":"duration","seconds":…}}`
and `200`.

### Step 8: HTTPS for the new names

The whole new `/etc/caddy/Caddyfile`. The TTS block is unchanged. Each ASR host forwards
only transcription, the model list and health; everything else, `/invocations` included
[S16], is a 404 before it reaches vLLM. `request_body` matches vLLM's 25 MB limit with a
413 [S35][S12].

```bash
ssh -i $KEY $HOST 'sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-asr'
ssh -i $KEY $HOST 'sudo tee /etc/caddy/Caddyfile >/dev/null' <<'EOF'
tts.jasenpan.com {
	# vLLM-Omni serves many routes (robot policies, video, metrics). Expose only speech and
	# the health check; everything else is a 404 before it reaches the model server.
	@api path /v1/audio/* /health
	handle @api {
		# -1 passes every write straight through, so streamed audio isn't held in a buffer.
		reverse_proxy 127.0.0.1:8091 {
			flush_interval -1
		}
	}
	handle {
		respond 404
	}
}

# Speech-to-text, Qwen3-ASR-1.7B. Its own key (/etc/asr/env), separate from the TTS's.
asr.jasenpan.com {
	request_body {
		max_size 25MB
	}
	# vLLM leaves /invocations unauthenticated, so forward only what clients need.
	@api path /v1/audio/transcriptions /v1/models /health
	handle @api {
		reverse_proxy 127.0.0.1:8092 {
			flush_interval -1
		}
	}
	handle {
		respond 404
	}
}
EOF
ssh -i $KEY $HOST 'sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy'
curl -s -o /dev/null -w "%{http_code}\n" https://asr.jasenpan.com/health
```

**Success:** `Valid configuration`, then `200` (the first request can take a few seconds
while Caddy obtains the certificate). `https://tts.jasenpan.com/health` still answers
`200`.

### Step 9: Copy the key to the Mac and test end to end

The key is copied without being shown, like the TTS key:

```bash
mkdir -p ~/.config/asr
(umask 077; ssh -i $KEY $HOST 'sudo sed -n "s/^VLLM_API_KEY=//p" /etc/asr/env' > ~/.config/asr/key)
```

Then, in zsh or bash on the Mac. `-H @<(…)` hands curl the header through a pipe, so the
key is neither printed nor visible in `ps` (if your shell rejects it, `-H "Authorization:
Bearer $(cat ~/.config/asr/key)"` as in the TTS README also works, with the key in `ps`
while curl runs). The TTS key is used only to make test clips:

```bash
ASR=https://asr.jasenpan.com
asr_auth() { printf 'Authorization: Bearer %s' "$(cat ~/.config/asr/key)"; }
tts_auth() { printf 'Authorization: Bearer %s' "$(cat ~/.config/qwen-tts/key)"; }
T=$(mktemp -d)

echo "health:      $(curl -s -o /dev/null -w '%{http_code}' $ASR/health)  (want 200)"
echo "other paths: $(curl -s -o /dev/null -w '%{http_code}' $ASR/invocations)  (want 404)"
echo "without key: $(curl -s -o /dev/null -w '%{http_code}' -F file=@/dev/null $ASR/v1/audio/transcriptions)  (want 401)"

# Non-sensitive test clips, spoken by the TTS server: short mixed, medium mixed, long mixed, English.
say_clip() {
  python3 -c 'import json, sys; print(json.dumps({"input": sys.argv[1], "voice": "serena", "language": sys.argv[2]}))' "$2" "$3" \
    | curl -s -H @<(tts_auth) -H 'Content-Type: application/json' -d @- https://tts.jasenpan.com/v1/audio/speech -o "$T/$1.wav"
}
say_clip short  "你去把这个 PR 给我 merge 一下。" Chinese
say_clip medium "后天的会先讲 deployment，然后看一下 UVAP 的 PR。如果测试都过了，我们周五就可以 release。" Chinese
say_clip long   "今天早上 staging 的 deploy 失败了两次，我看了一下 log，好像是 database migration 的问题。你先帮我把那个 PR revert 掉，然后跑一遍 integration test。如果还是不行，我们下午开个短会，把 rollback 的方案定下来，顺便看一下 UVAP 那边的 API 有没有变化。" Chinese
say_clip english "Can you take a look at the pull request for the billing service before lunch? The tests pass locally, but the staging deploy failed twice this morning." English

for clip in short medium long english; do
  for run in 1 2 3; do
    curl -s -w "  [$clip run $run: %{http_code} in %{time_total}s]\n" -H @<(asr_auth) \
      -F file=@"$T/$clip.wav" -F model=Qwen/Qwen3-ASR-1.7B $ASR/v1/audio/transcriptions
  done
done
```

**Success:** `200`, `404`, `401`; every clip returns `200` with its text and
`usage.seconds` (the clip length); "PR", "merge", "deployment", "UVAP", "release" come
back in Latin script; the Chinese is in Simplified characters. Record the second and third
`time_total` per clip next to its `usage.seconds`. That is the latency answer for Sounds
Good: anything over ~1.5 s for the long clip means the 3 s budget is in trouble (see
[Latency](#latency-on-an-l4-inference-to-be-measured)).

Context biasing, for comparison with Fun-ASR later: repeat the medium clip with
`-F prompt="UVAP, Multi-Code"` and see whether anything changes.

### Step 10 (deferred): Fun-ASR-Nano, taking turns with Qwen3-ASR

**Not part of the current deployment** (builder, 2026-10-08; see the top). Kept for reference
if Qwen3-ASR falls short. Running it would also need the `funasr` DNS record from step 2 and
this block added to the Caddyfile from step 8:

```caddyfile
# Speech-to-text, Fun-ASR-Nano-2512. Same key as asr.jasenpan.com. Answers 502 while its
# container is stopped, which is normal: the two ASR servers take turns.
funasr.jasenpan.com {
	request_body {
		max_size 25MB
	}
	@api path /v1/audio/transcriptions /v1/models /health
	handle @api {
		reverse_proxy 127.0.0.1:8093 {
			flush_interval -1
		}
	}
	handle {
		respond 404
	}
}
```

Build its image from the version its packaging is validated on [S27], the same documented
recipe as step 5 [S13]. This is a separate ~9 GB download [S18]: check `df -h /` first.

```bash
ssh -i $KEY $HOST 'bash -s' <<'EOF'
set -euo pipefail
sudo docker pull vllm/vllm-openai:v0.27.1
sudo docker run --rm --entrypoint python3 vllm/vllm-openai:v0.27.1 -c 'import vllm; print(vllm.__version__)'
sudo docker build -t asr-vllm:v0.27.1 - <<'DOCKERFILE'
FROM vllm/vllm-openai:v0.27.1
RUN uv pip install --system "vllm[audio]==0.27.1"
DOCKERFILE
EOF
```

**Success:** version `0.27.1`; the build adds only the audio packages.

Free the slot and start Fun-ASR with the card's command [S27], plus this card's share and
length limit:

```bash
ssh -i $KEY $HOST 'bash -s' <<'EOF'
set -euo pipefail
sudo docker stop qwen-asr
sudo docker rm -f fun-asr >/dev/null 2>&1 || true
sudo docker run -d --name fun-asr --restart unless-stopped --runtime nvidia --gpus all --ipc=host \
  --env-file /etc/asr/env \
  -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
  -p 127.0.0.1:8093:8000 \
  asr-vllm:v0.27.1 \
  --model FunAudioLLM/Fun-ASR-Nano-2512-vllm \
  --revision vllm-0.27.1-20260830 \
  --served-model-name fun-asr-nano \
  --dtype float32 \
  --enforce-eager \
  --gpu-memory-utilization 0.30 \
  --max-model-len 4096
for _ in $(seq 1 90); do
  if curl -sf -o /dev/null localhost:8093/health; then echo READY; break; fi
  sleep 10
done
curl -sfL -o /tmp/fun_zh.mp3 https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-2512-vllm/resolve/vllm-0.27.1-20260830/example/zh.mp3
sudo bash -c '. /etc/asr/env; curl -s localhost:8093/v1/audio/transcriptions -H "Authorization: Bearer $VLLM_API_KEY" \
  -F file=@/tmp/fun_zh.mp3 -F model=fun-asr-nano -F language=zh -F temperature=0 -F response_format=json'; echo
sudo bash -c '. /etc/asr/env; curl -s localhost:8093/v1/audio/transcriptions -H "Authorization: Bearer $VLLM_API_KEY" \
  -F file=@/tmp/fun_zh.mp3 -F model=fun-asr-nano -F language=zh -F temperature=0 -F response_format=json \
  -F hotwords=开放时间'; echo
EOF
```

**Success:** `READY`; without hotwords the text is exactly `开饭时间早上九点至下午五点。`,
the card's expected output for that pinned sample [S27]. With the hotword: the original
model card's example runs this same sample with `hotwords=["开放时间"]` [S28], so the second line should read
`开放时间…` (**inference**: no document states that output). Then repeat step 9's loop
against `https://funasr.jasenpan.com` with `-F model=fun-asr-nano -F temperature=0`, and once
with `-F hotwords="UVAP, Multi-Code"`.

Switching afterwards (`unless-stopped` keeps a stopped container stopped, even across
reboots [S36]):

```bash
ssh -i $KEY $HOST 'sudo docker stop fun-asr && sudo docker start qwen-asr'   # back to Qwen3-ASR
ssh -i $KEY $HOST 'sudo docker stop qwen-asr && sudo docker start fun-asr'   # to Fun-ASR
```

Never start both while the TTS runs.

### Step 11: Stop and start the instance once

With Qwen3-ASR as the running ASR container: EC2 console → the instance → **Instance
state → Stop instance**, then **Start instance**. After a few minutes:

```bash
for h in tts asr; do echo "$h: $(curl -s -o /dev/null -w '%{http_code}' https://$h.jasenpan.com/health)"; done
ssh -i $KEY $HOST 'sudo docker ps --format "{{.Names}} {{.Status}}"; for c in qwen-tts qwen-asr; do echo "$c restarts: $(sudo docker inspect -f "{{.RestartCount}}" $c)"; done'
```

**Success:** both `200` with nobody logging in. A non-zero restart count means the two servers raced at boot (see
Risks) and recovered; note it. If one never comes up, read its log before changing
anything. This also covers the TTS check the hosting record left open.

### Day to day

- **Logs:** `sudo docker logs --tail 50 qwen-asr`, `journalctl -u caddy`.
- **GPU:** `sudo nvidia-smi --query-compute-apps=pid,used_memory --format=csv`.
- **New ASR key:** `sudo rm /etc/asr/env`, re-run step 4, re-create the ASR containers
  with the `docker run` of step 6 (`--env-file` is read when a container is
  created, so `docker restart` would keep the old key), then re-copy as in step 9.
- **Tear down ASR only:** remove the container (`sudo docker rm -f qwen-asr`), the image
  (`sudo docker rmi asr-vllm:v0.30.0`), the `asr` Caddy block and DNS record, then re-run step 3 without
  `--stage-overrides` if the TTS should have the card back.

## Calling it

Only `asr.jasenpan.com` (Qwen3-ASR-1.7B) is being deployed. The Fun-ASR column and
comments below apply only if the deferred step 10 is ever run; `funasr.jasenpan.com` does
not exist.

What Sounds Good needs. Same contract on both hosts; only the URL and model name differ.

| | Qwen3-ASR-1.7B | Fun-ASR-Nano-2512 |
|---|---|---|
| URL | `https://asr.jasenpan.com/v1/audio/transcriptions` | `https://funasr.jasenpan.com/v1/audio/transcriptions` |
| `model` | `Qwen/Qwen3-ASR-1.7B` | `fun-asr-nano` |
| Available | Normally | Only when its container is the one running; 502 otherwise |

- **Auth:** `Authorization: Bearer <key>`, the key in `~/.config/asr/key` on the Mac (the
  same key for both hosts; not the TTS key). Wrong or missing key: `401`.
- **Request:** `POST`, `multipart/form-data` [S7][S8]:

  | Field | Send | Notes |
  |---|---|---|
  | `file` | always | m4a, wav, flac, mp3, ogg, webm, mp4; ≤ 25 MB, ≤ 600 s. 16 kHz mono is what the model uses; compressed formats upload faster |
  | `model` | recommended | Must match the table above, else `404`; `GET /v1/models` lists it |
  | `response_format` | `json` | `text` returns the bare string. No `verbose_json` on Qwen3-ASR |
  | `temperature` | `0` | Greedy, the default; Fun-ASR's card sends it explicitly |
  | `prompt` | Qwen3-ASR only | Free text the model treats as background, e.g. `"UVAP, Multi-Code, Bedrock"`; soft. Keep it to a few hundred tokens (requests are capped at 4,096 tokens) |
  | `hotwords` | Fun-ASR only | One string, terms joined by `", "`; also a prompt, trained for it but not enforced |
  | `language` | usually omit | `zh` or `en`. Qwen3-ASR: forces the output language, so omit for mixed speech. Fun-ASR: ignored except for joining >30 s chunks. For clips over 30 s, `zh` avoids a stray space at the 30 s join in Chinese text |
  | `stream` | no | `true` streams text as server-sent events, but only after the upload |
- **Response:** `200`, `{"text": "你去把这个 PR 给我 merge 一下。", "usage": {"type": "duration", "seconds": 3}}`.
  No timestamps, speakers or language tag in `json`.
- **Errors:** `400` bad field, `401` key, `404` unknown path or model name, `413` over 25 MB
  (Caddy), `502` server stopped or still loading (Caddy can't reach it; after a start allow
  2–5 minutes). Treat `502`, `5xx` and timeouts as "speech-to-text unavailable".
- **Limits and behaviour:** batch only (transcribed after the upload completes); clips over
  30 s are split at a quiet point and transcribed in parallel; the server batches
  concurrent requests. No hard dictionary on either model: a term that must always be
  spelled one way has to be enforced in Sounds Good's own post-processing (its rewrite
  step), not here (**inference** from the two prompt mechanisms above).

curl:

```bash
curl -s https://asr.jasenpan.com/v1/audio/transcriptions \
  -H @<(printf 'Authorization: Bearer %s' "$(cat ~/.config/asr/key)") \
  -F file=@clip.m4a -F model=Qwen/Qwen3-ASR-1.7B -F response_format=json -F temperature=0 \
  -F prompt="UVAP, Multi-Code"
```

TypeScript (Node 20+ or Electron main; `fetch`, `FormData` and `Blob` are built in):

```ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ASR_URL = "https://asr.jasenpan.com/v1/audio/transcriptions";
const ASR_MODEL = "Qwen/Qwen3-ASR-1.7B"; // "fun-asr-nano" on funasr.jasenpan.com

export async function transcribe(audio: Uint8Array, filename = "clip.m4a", mime = "audio/mp4"): Promise<string> {
  const key = (await readFile(join(homedir(), ".config/asr/key"), "utf8")).trim();
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mime }), filename);
  form.append("model", ASR_MODEL);
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("prompt", "UVAP, Multi-Code"); // Fun-ASR: form.append("hotwords", "UVAP, Multi-Code")
  const res = await fetch(ASR_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`speech-to-text ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { text: string; usage: { type: "duration"; seconds: number } };
  return body.text;
}
```

## Moving to the company account (ap-southeast-2)

The same steps 3–10 apply on a g6.xlarge in Sydney. What changes:

- **Capacity.** On 2026-10-07 no g6.xlarge or g4dn.xlarge launched in ap-southeast-2a, 2b
  or 2c, and g5 isn't offered in 2b (hosting record). Retry, ask for an On-Demand Capacity
  Reservation [S38], or try g5.xlarge (A10G, also 24 GB; this plan should carry over, but
  untested). g6.xlarge costs $1.0464/h there, ~$760/month always on [SG].
- **No TTS on that card** (the TTS is the builder's personal POC). Then both ASR servers
  can run at once, Qwen3-ASR at 0.40 and Fun-ASR at 0.40, without taking turns.
- **HTTPS:** an Application Load Balancer with an ACM certificate instead of Caddy
  (hosting record "Later") [S38]. Recreate the path allowlist as listener rules
  (`/v1/audio/transcriptions`, `/v1/models`, `/health` forward; default action a fixed
  404). The ALB bills while the instance is stopped. Whether it is internet-facing or
  internal behind the company VPN is the company's call.
- **Key:** Secrets Manager instead of `/etc/asr/env` [S38]; infrastructure in Terraform or
  CDK (hosting record).
- **Evidence for the data boundary:** keep `VLLM_NO_USAGE_STATS=1` / `DO_NOT_TRACK=1`
  [S17]; set `HF_HUB_OFFLINE=1` once weights are cached so nothing calls Hugging Face at
  run time [S39]; tighten the security group's outbound rules after setup; VPC Flow Logs
  are the "network connection records" the intent asks for [S38]. Build time still pulls
  from Docker Hub, PyPI and Hugging Face (model and code in, nothing out); if the company
  wants no public egress at all, mirror the images to ECR and the weights to S3 first
  (**inference**: standard AWS practice, not a vendor requirement).
- **Latency** improves: Bedrock for the rewrite step and the ASR are both in Sydney, so the
  trans-Pacific round trip in step 9's numbers disappears.

## Cost and lifecycle

- **No new instance cost.** Same g6.xlarge ($0.80/h in us-west-2 while running), volume
  (~$8/month) and Elastic IP (~$3.60/month) as the TTS README lists. Two more DNS records
  in an existing hosted zone.
- **Disk:** Qwen3-ASR weights 4.7 GB [S2]; its image adds only the audio layer on top of
  layers the TTS already has [S19]. Fun-ASR adds 2 GB of weights and the v0.27.1 image
  (9.11 GB compressed, more unpacked) [S27][S18]. Check `df -h /` before step 10; growing
  the gp3 volume costs about $0.08 per GB-month.
- **First run:** Qwen3-ASR about 5–10 minutes (weights, then compile and CUDA-graph
  capture); later starts a couple of minutes, faster with the compile cache volume [S13].
  Fun-ASR about 5–10 minutes the first time, mostly the image pull.
- **Restarts:** `--restart unless-stopped` brings the running containers back after a stop
  and start; a container stopped by hand stays stopped [S36]. Weights live under
  `/home/ubuntu/.cache/huggingface` on the root volume, so they survive a stop and are
  deleted with the instance.

## Open questions and what I could not verify

1. **The TTS's real memory today**, and whether the global flag really is applied per stage
   on this server. Docs and code say so; step 1 shows it.
2. **Whether 0.25 / 0.15 holds the 1.7B TTS** and how high its peaks go. The vendor's 24 GB
   numbers are for the 0.6B model [S24]; step 3 measures.
3. **Latency of the 1.7B on an L4 for 30 s clips.** The bandwidth estimate says ~1.5–2 s of
   GPU time; the vendor's speed figures are from an unnamed GPU [S3]. Step 9 decides; the
   0.6B is the fallback.
4. **Fun-ASR on vLLM 0.27.1 on an L4**, in fp32 and eager mode. Validated only on an H100
   [S27]. Speed is unknown and possibly slower than Qwen3-ASR-1.7B despite the smaller
   model.
5. **Chinese-English mixed speech, English terms in Latin script, Simplified vs
   Traditional:** no vendor numbers for Qwen3-ASR; Fun-ASR's code-switching numbers may be
   for the 7.7B model, not Nano [S32]. Sounds Good's recorded test set has to decide. If
   Traditional characters ever appear, a client-side conversion (e.g. OpenCC) is the usual
   fix (**inference**).
6. **Fun-ASR-Nano hotword recall through vLLM** (prompt only, no CTC retrieval): no
   published figure.
7. **Qwen3-ASR realtime with the 1.7B:** documented with the 0.6B as the example [S6], and
   its fixed 5 s segments without context may cost accuracy. Untested.
8. **Boot-time race** between two vLLM servers profiling at once [S14]: step 11 will show
   whether restarts happen.
9. **Shared image layers:** I read the Omni Dockerfile, not the published image manifests;
   step 5's pull output confirms or refutes it.
10. **For the company:** Sydney GPU capacity, whether the company allows build-time egress
    to Docker Hub, PyPI and Hugging Face, internet-facing vs internal access, and whether
    the personal server may be used even for synthetic clips.

### Where this differs from the earlier hosting notes

- "Lowering the speech container's `--gpu-memory-utilization` from 0.9 to about 0.45":
  that flag is applied to each of the TTS's two stages [S21][S23], so 0.45 would let the
  TTS reserve up to ~0.9 of the card again. Use `--stage-overrides` (step 3). It also means
  the YAML's per-stage 0.3 values have been overridden all along.
- "`vllm serve Qwen/Qwen3-ASR-1.7B`, OpenAI `/v1/audio/transcriptions`": correct, but the
  official image needs the documented `vllm[audio]` layer [S13], and on a shared card it
  needs an explicit `--gpu-memory-utilization` (default 0.92) and `--max-model-len` [S14][S15].
- The TTS README's "Later" idea of routing `/v1/audio/transcriptions` on `tts.jasenpan.com`
  to the ASR server is replaced by its own host and its own key.

## Sources

Local: `deploy/tts-server/README.md`; `docs/timeline/2026-10-07_voice-engine-hosting.md`;
`docs/knowledge/tech-conventions.md`; Sounds Good's
`/Users/jasenpan/code/apra/sounds-good/intent/001-voice-input.md` and [SG]
`/Users/jasenpan/code/apra/sounds-good/research/2026-10-07-speech-to-text.md`.

- [S1] Qwen3-ASR README (Deployment with vLLM, Streaming Inference, Docker, `qwen-asr-serve`): https://github.com/QwenLM/Qwen3-ASR · SDK context: https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/qwen3_asr.py
- [S2] Qwen3-ASR-1.7B card and files (`config.json`, `preprocessor_config.json`, safetensors 4.22 + 0.48 GB): https://huggingface.co/Qwen/Qwen3-ASR-1.7B
- [S3] Qwen3-ASR technical report (20-minute input, context biasing, efficiency with vLLM v0.14.0): https://arxiv.org/abs/2601.21337
- [S4] vLLM recipe for Qwen3-ASR: https://github.com/vllm-project/recipes/blob/main/Qwen/Qwen3-ASR.md
- [S5] vLLM releases: v0.16.0 (Qwen3-ASR #33312, Realtime API #33187) https://github.com/vllm-project/vllm/releases/tag/v0.16.0 · v0.17.0 (FunASR #33247, Qwen3-ASR realtime #34613) https://github.com/vllm-project/vllm/releases/tag/v0.17.0
- [S6] vLLM supported models, Transcription and Realtime Transcription tables, v0.30.0: https://github.com/vllm-project/vllm/blob/v0.30.0/docs/models/supported_models.md
- [S7] vLLM Speech-to-Text APIs, v0.30.0: https://github.com/vllm-project/vllm/blob/v0.30.0/docs/serving/online_serving/speech_to_text.md
- [S8] Transcription request and response models: https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/entrypoints/speech_to_text/transcription/protocol.py
- [S9] Chunking, joining, streaming: https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/entrypoints/speech_to_text/base/serving.py · https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/config/speech_to_text.py
- [S10] Qwen3-ASR in vLLM: https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/model_executor/models/qwen3_asr.py · https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/model_executor/models/qwen3_asr_realtime.py · config: https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/transformers_utils/configs/qwen3_asr.py
- [S11] FunASR in vLLM: https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/model_executor/models/funasr.py
- [S12] Audio limits (`VLLM_MAX_AUDIO_*`): https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/envs.py
- [S13] vLLM Docker image, optional dependencies, derived Dockerfile: https://github.com/vllm-project/vllm/blob/v0.30.0/docs/getting_started/installation/gpu.cuda.inc.md · compile cache: https://github.com/vllm-project/vllm/blob/v0.30.0/docs/deployment/docker.md · `audio` extra: https://github.com/vllm-project/vllm/blob/v0.30.0/setup.py · placeholders: https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/multimodal/audio.py
- [S14] `gpu_memory_utilization` (default 0.92, per instance): https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/config/cache.py · start-up check: https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/v1/worker/utils.py · profiling and KV budget: https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/v1/worker/gpu_worker.py
- [S15] `max_model_len`, including `auto`: https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/config/model.py
- [S16] API key scope: https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/entrypoints/serve/middleware/authenticate.py · https://github.com/vllm-project/vllm/blob/v0.30.0/vllm/entrypoints/launchers/cli_args.py · https://docs.vllm.ai/en/latest/usage/security.html
- [S17] vLLM usage stats and opting out: https://github.com/vllm-project/vllm/blob/v0.30.0/docs/usage/usage_stats.md
- [S18] Docker Hub `vllm/vllm-openai` tags (amd64 compressed: v0.30.0 8.73 GB, v0.27.1 9.11 GB, v0.31.0 9.04 GB): https://hub.docker.com/r/vllm/vllm-openai/tags
- [S19] vLLM-Omni image base: https://github.com/vllm-project/vllm-omni/blob/v0.30.0/docker/Dockerfile.cuda
- [S20] Qwen3-TTS deploy config: https://github.com/vllm-project/vllm-omni/blob/v0.30.0/vllm_omni/deploy/qwen3_tts.yaml
- [S21] Stage configs, precedence, `--stage-overrides`: https://github.com/vllm-project/vllm-omni/blob/v0.30.0/docs/configuration/stage_configs.md
- [S22] Stage memory on a shared GPU: https://github.com/vllm-project/vllm-omni/blob/v0.30.0/docs/configuration/gpu_memory_utilization.md
- [S23] Tolerant memory request: https://github.com/vllm-project/vllm-omni/blob/v0.30.0/vllm_omni/worker/memory_utils.py · CLI keys into stage overrides: https://github.com/vllm-project/vllm-omni/blob/v0.30.0/vllm_omni/config/stage_config.py · explicit-flag tracking: https://github.com/vllm-project/vllm-omni/blob/v0.30.0/vllm_omni/utils/tracking_parser.py
- [S24] Qwen3-TTS recipe, RTX 4090 24 GB and A100 40 GB profiles: https://github.com/vllm-project/vllm-omni/blob/v0.30.0/recipes/Qwen/Qwen3-TTS.md
- [S25] vLLM-Omni supported models, v0.30.0: https://github.com/vllm-project/vllm-omni/blob/v0.30.0/docs/models/supported_models.md
- [S26] Qwen3-TTS-12Hz-1.7B-CustomVoice files and config: https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
- [S27] Fun-ASR-Nano-2512 for vLLM (validated path, provenance, pinned sample, configs): https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-2512-vllm
- [S28] Fun-ASR-Nano-2512 card (languages, Apache-2.0, hotwords example, benchmarks): https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-2512
- [S29] Fun-ASR README, capability boundaries and licence: https://github.com/FunAudioLLM/Fun-ASR (now `QwenAudio/Fun-ASR`)
- [S30] Fun-ASR vLLM guide (`serve_vllm.py`, `serve_realtime_ws.py`, SenseVoice not supported): https://github.com/QwenAudio/Fun-ASR/blob/main/docs/vllm_guide.md
- [S31] Fun-ASR prompt construction: https://github.com/QwenAudio/Fun-ASR/blob/main/model.py
- [S32] Fun-ASR technical report (Sections 5.4, 5.5; Tables 5, 6): https://arxiv.org/abs/2509.12508
- [S33] NVIDIA ASR NIM support matrix: https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html · HTTP API: https://docs.nvidia.com/nim/speech/latest/reference/api-references/asr/http-asr.html · licence: https://docs.nvidia.com/nim/speech/latest/get-started/prerequisites.html
- [S34] NVIDIA L4 specifications: https://www.nvidia.com/en-us/data-center/l4/
- [S35] Caddy: https://caddyserver.com/docs/caddyfile/directives/request_body · https://caddyserver.com/docs/caddyfile/directives/reverse_proxy · https://caddyserver.com/docs/automatic-https
- [S36] Docker restart policies: https://docs.docker.com/engine/containers/start-containers-automatically/
- [S37] Route 53 records: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html
- [S38] AWS: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-https-listener.html · https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html · https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs.html · https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-capacity-reservations.html
- [S39] Hugging Face Hub environment variables (`HF_HUB_OFFLINE`): https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables
- [S40] NVIDIA Multi-Process Service: https://docs.nvidia.com/deploy/mps/index.html
- [S41] Whisper large-v3-turbo (MIT, 1.62 GB safetensors): https://huggingface.co/openai/whisper-large-v3-turbo
- [S42] SenseVoice-Small card (languages, `license: other`, FunASR MODEL_LICENSE): https://huggingface.co/FunAudioLLM/SenseVoiceSmall
