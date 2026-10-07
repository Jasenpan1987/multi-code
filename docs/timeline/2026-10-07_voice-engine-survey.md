# Voice Engine Survey — investigation

**Date:** 2026-10-07
**Type:** investigation
**Participants:** Claude (research subagent), for Jasen (builder)
**Source:** desk research from primary pages (vendor docs, pricing pages, AWS Price List API, GitHub, Hugging Face), a few GitHub issues and Hacker News threads. No web search engine was reachable. No option was checked by ear.
**Feeds:** `docs/specs/voice-secretary/gaps.md` G-001, G-002

## Summary

Scope followed the builder's constraint: AWS first, then well-known open models, then
small local models; SaaS-only vendors get one reference row each. AWS has no
competitive Mandarin TTS. The strongest option inside the constraint is a local model,
Qwen3-TTS. Chinese–English mixing inside a sentence is weak in every engine measured,
so the language model writing the brief should produce speech-ready text (acronyms
spelled out, no hyphens or slashes, numbers written out); that matters more than the
engine. Cost assumption throughout: 50 briefs a day × 250 characters ≈ 375k characters
a month ≈ 1,400 audio minutes.

## Key Findings

- **Bedrock has no plain text-to-speech model.** Nova 2 Sonic and Nova 2.5 Sonic (GA
  2026-10-05) are speech-to-speech only, don't speak Mandarin (en, fr, it, de, es, pt,
  hi), and aren't offered in Sydney. The only TTS in Bedrock Marketplace is MARS6, with
  no language list and per-instance-hour billing.
- **Polly's only Mandarin voice is Zhiyu** (Neural/Standard, 2022). The generative
  engine has no Chinese voice. Neural is in ap-southeast-2, $16 per 1M characters
  (~$6/month). Polly may store and use text inputs unless the AWS Organizations
  AI-services opt-out policy is set.
- **macOS Premium/Enhanced Chinese voices** (Tingting premium-high, Yu-shu, Li-mu) are
  downloadable, free, and usable by a third-party app through `AVSpeechSynthesizer`.
  Siri's neural zh-CN voice (Linfei) shows up from an unsandboxed process on this Mac,
  but Apple says Siri voices are off-limits to third parties (WWDC20); undocumented and
  may break.
- **Mixed-language accuracy is a weak spot everywhere.** The one mixed-text benchmark
  (INTP, 2025-05) puts open models at 23–54% word error rate on mixed text against
  ~1–3% on single-language text. No commercial API publishes a mixed-text number.

## Local Models (Apple Silicon)

| Model | Size | Runs on Apple Silicon? | Speed | License | Adoption |
|---|---|---|---|---|---|
| **Qwen3-TTS 12Hz 0.6B / 1.7B CustomVoice** (2026-01-22) | 2.0 / 3.1 GB as MLX 8-bit | Yes: mlx-audio (Python, OpenAI-compatible server) or Argmax TTSKit (CoreML, Swift) | M5 Max, 1.7B 8-bit: RTF ~0.25; TTSKit first step ~80 ms. No base M1/M2 numbers. | Apache-2.0 | 13.7k stars, default model in mlx-audio |
| Fun-CosyVoice3-0.5B-2512 | ~5 GB of files | Partly: MLX port unmerged, `ttsfrd` frontend Linux x86 only | Not reported on Mac | Apache-2.0 | 23.9k stars |
| IndexTTS-2.5 (2026-08) | ~1.5B, 5.5 GB | PyTorch MPS (one user report) | Not reported | bilibili license, OK under 100M MAU | 24.3k stars |
| VoxCPM2 (2B) / VoxCPM1.5 (0.6B) | 2–5 GB | Yes: mlx-audio, llama.cpp GGUF | VoxCPM2 Q8 on M4 Pro: RTF 1.76 (slower than real time) | Apache-2.0 | 38.4k stars |
| MOSS-TTS-Nano-100M (2026-04) | 0.67 GB ONNX | Yes: ONNX CPU, mlx-audio | "Smooth on 1 CPU core", M4 Air | Apache-2.0 | 4.4k stars |
| Kokoro-82M-v1.1-zh | 147 MB int8 | Yes: `sherpa-onnx-node` in-process | Near real time on M1 CPU | Apache-2.0 | Mixing essentially broken |
| sherpa-onnx Matcha zh-en / MeloTTS zh_en | ~170 MB | Yes: `sherpa-onnx-node` | Not reported | MeloTTS MIT | Built for mixed zh-en, older naturalness |

Not usable commercially: Fish S2 Pro / OpenAudio S1-mini, F5-TTS weights, Spark-TTS,
OmniVoice weights, Higgs v3.

Mixing reports from GitHub issues: CosyVoice skips or garbles English words (#388,
#1254); IndexTTS reads "Anti-Gravity" as "Anti减Gravity" (#565); Qwen3-TTS reads digits
in Chinese inside English text (#68); VoxCPM misreads English in Chinese sentences
(#126, #289); Kokoro doesn't attempt English words (hexgrad/kokoro #238).

## SaaS Reference Rows

Outside the constraint, recorded for comparison only. Azure zh-CN Neural / DragonHD had
the best user praise and auto-detects language ($11–17/month, CJK counted ×2; HD not in
Australia East). Others: Google Chirp 3 HD cmn-CN, Gemini 3.8 Flash TTS, Alibaba hosted
qwen3-tts-flash (Singapore), MiniMax speech-2.8, ElevenLabs v4, OpenAI gpt-4o-mini-tts
("optimized for English"), Fish Audio, Cartesia, Volcengine/BytePlus Doubao. Hume's TTS
API shuts down 2026-11-13.

## Top Picks Within the Constraint

1. **Qwen3-TTS 1.7B CustomVoice, local** (0.6B on smaller Macs), through an mlx-audio
   sidecar or a TTSKit Swift helper. Apache-2.0, native Chinese preset voices (Serena,
   Vivian), streaming, faster than real time on a Mac, free, nothing leaves the machine.
   Risk: shipping a Python/MLX or Swift sidecar plus a 2–3 GB model download inside
   Electron; ~7–8% of mlx-audio runs speak at ~0.45× speed (mlx-audio #1002, filed
   2026-10-06), plus sentence-tail truncation.
2. **Fun-CosyVoice3-0.5B, local.** Best measured Chinese accuracy among small
   commercial-OK models (Seed zh CER 0.81), with Pinyin/CMU-phoneme overrides for terms
   like "pnpm". Risk: no mature Apple Silicon path yet.
3. **Polly Zhiyu Neural.** The only Mandarin TTS in AWS Sydney: IAM auth,
   `@aws-sdk/client-polly`, ~$6/month. Risk: very likely misses the "real person" bar.

## Bedrock Text Model for the Brief (ap-southeast-2)

USD per 1M tokens, Sydney on-demand, AWS Price List API. Monthly cost assumes 1,500
calls × 10k input + 400 output tokens.

| Model | ID / profile | In / Out | ~$/month |
|---|---|---|---|
| Claude Haiku 4.5 | `au.anthropic.claude-haiku-4-5-20251001-v1:0` (stays in Sydney + Melbourne) | $1.10 / $5.50 | $19.80 |
| Qwen3 235B A22B 2507 | `qwen.qwen3-235b-a22b-2507-v1:0` | $0.2266 / $0.906 | $3.94 |
| Qwen3 32B | `qwen.qwen3-32b-v1:0` | $0.1545 / $0.618 | $2.69 |
| Nova Lite / Nova Micro | `amazon.nova-lite-v1:0` / `amazon.nova-micro-v1:0` | $0.063 / $0.252 and $0.037 / $0.148 | $1.10 / $0.64 |
| DeepSeek V3.2 / GLM 4.7 Flash | `deepseek.v3.2` / `zai.glm-4.7-flash` | $0.64 / $1.91 and $0.07 / $0.41 | $10.75 / $1.30 |

Haiku 4.5's Bedrock card says "EOL no sooner than Oct 16, 2026", with a legacy period of
at least six months. Chinese-quality evidence for all of these is thin; a side-by-side
on real transcripts would settle it.

## Unverified

CJK billing rules for Polly, MiniMax, ElevenLabs, Cartesia; foreign-account requirements
for Alibaba, MiniMax, Volcengine; mixing quality for every commercial API; Mac speed for
CosyVoice3 and IndexTTS; data policies for non-AWS vendors.

## Sources

- Polly pricing: https://aws.amazon.com/polly/pricing/ (Sydney Price List API, 2026-09-11)
- Polly voices: https://docs.aws.amazon.com/polly/latest/dg/available-voices.html
- Polly generative voices: https://docs.aws.amazon.com/polly/latest/dg/generative-voices.html
- Polly `<lang>` tag: https://docs.aws.amazon.com/polly/latest/dg/lang-tag.html
- Polly data use: https://aws.amazon.com/polly/faqs/
- AI-services opt-out: https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_ai-opt-out_all.html
- Nova 2 Sonic languages: https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-language-support.html
- Nova 2.5 Sonic launch: https://aws.amazon.com/about-aws/whats-new/2026/10/amazon-nova-2.5-sonic/
- Bedrock Marketplace catalog: https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-marketplace-model-reference.html
- Bedrock data retention: https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html
- Haiku 4.5 card: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html
- INTP mixed-text benchmark: https://arxiv.org/html/2505.04113
- Qwen3-TTS: https://github.com/QwenLM/Qwen3-TTS, https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice, report https://arxiv.org/html/2601.15621
- mlx-audio glitch report: https://github.com/Blaizzy/mlx-audio/issues/1002
- Argmax TTSKit: https://github.com/argmaxinc/argmax-oss-swift
- CosyVoice: https://github.com/FunAudioLLM/CosyVoice; MLX port https://github.com/Blaizzy/mlx-audio/pull/861
- IndexTTS: https://github.com/index-tts/index-tts
- VoxCPM: https://github.com/OpenBMB/VoxCPM
- MOSS-TTS-Nano: https://github.com/OpenMOSS/MOSS-TTS-Nano
- Kokoro zh: https://hf.co/hexgrad/Kokoro-82M-v1.1-zh
- sherpa-onnx zh-en models: https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/
- macOS voice quality tiers: https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoicequality
- Siri voices off-limits: https://developer.apple.com/videos/play/wwdc2020/10022/
- Azure HD voices: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/high-definition-voices
- Hume shutdown: https://dev.hume.ai/docs/text-to-speech-tts/overview
- Artificial Analysis TTS leaderboard: https://artificialanalysis.ai/text-to-speech/leaderboard
