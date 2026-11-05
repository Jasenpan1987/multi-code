# Cloudflare and Gemini TTS for the Secretary — investigation

**Date:** 2026-11-05
**Type:** investigation
**Participants:** Claude, for Jasen (builder)
**Source:** vendor docs and pricing pages, the Cloudflare and Google AI Studio dashboards
of the builder's own new free accounts, and live calls from those accounts. The 11
briefs of the 2026-10-08 language A/B (personal projects only) were spoken by each
engine and listened to by the builder.

## Summary

The question was whether a free cloud engine could replace the self-hosted Qwen3-TTS
server (`deploy/tts-server/`), which costs money while it runs and fails while it is
stopped. Cloudflare Workers AI's MeloTTS is free for a whole day of briefs and fits the
secretary's audio path; the builder chose it, and Multi-Code now accepts either server,
told apart by the address. Gemini's TTS sounded better (male voice `achird`), but its
free tier allows 10 calls a day per model, and on Cloudflare it is not free at all.

## Cloudflare Workers AI

- **Free allocation:** 10,000 neurons a day on the Free plan, reset at 00:00 UTC. Past
  it, calls fail with an error. It covers only Cloudflare-hosted models (`@cf/...`).
- **Two catalogs.** Workers AI's own list has four TTS models. The unified catalog
  (`developers.cloudflare.com/ai/models/`, after Workers AI and AI Gateway merged in
  August 2026) adds third-party ones: `google/gemini-3.8-flash-tts`,
  `google/gemini-3.8-flash-lite-tts`, `google/gemini-3.1-flash-tts`, MiniMax,
  ElevenLabs, Inworld, OpenAI, xAI. Third-party models are paid from prepaid credits
  (card only, 5% fee on purchase); the docs name no free allowance for them.
- **Measured:** on the free account, `google/gemini-3.8-flash-tts` and the Lite model
  both answer HTTP 500 `Model execution failed (Error)`, code 2002, even with the docs'
  own example, while `@cf/myshell-ai/melotts` works through the same `/ai/run` route.

| Hosted TTS model | Free per day | Chinese |
|---|---|---|
| `@cf/myshell-ai/melotts` | ~536 audio minutes (18.63 neurons a minute) | Yes (`lang: "zh"`, mixes English) |
| `@cf/deepgram/aura-1` | ~7,300 characters (~11 English briefs) | No |
| `@cf/deepgram/aura-2-en` | ~3,700 characters (~5 English briefs) | No |
| `@cf/deepgram/aura-2-es` | Spanish only | No |

### MeloTTS as measured

- `POST https://api.cloudflare.com/client/v4/accounts/<account id>/ai/run/@cf/myshell-ai/melotts`,
  `Authorization: Bearer <Workers AI API token>`, body `{"prompt": …, "lang": "zh" | "en"}`.
- Answers `{"result": {"audio": "<base64>"}, "success": true}`. The audio is **WAV**
  (RIFF, 44.1 kHz, mono, 16-bit), not the MP3 its schema describes, so `isWav` and
  `loudness.ts` take it as they are. It comes out quiet (peak 6,326 of 32,767 on a
  Chinese sentence); `normalizeLoudness` brings it to 23,339.
- The 11 briefs took 2.1 to 6.0 s each (Qwen3-TTS on the L4: 12 to 21 s) and made
  6.2 minutes of audio, about 120 neurons. A month of the builder's turns (1,896 turn
  endings, 2026-09-28 to 2026-10-28, ~63 a day) would use under a tenth of the allocation.
- A wrong token, no token and a wrong account ID all answer the same HTTP 401
  `{"errors": [{"code": 10000, "message": "Authentication error"}]}`. Any path on the
  API host wants the token, so there is no public `/health`.
- One voice per language, no tone instructions. The builder found the Chinese voice
  poor next to Serena at first, then chose it for being free all day.

## Gemini TTS through Google AI Studio

- Models: `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts` (also 3.1 Flash and 2.5
  Flash TTS). REST: `POST /v1beta/interactions`, header `x-goog-api-key`, style in
  `speech_metadata.style`, voice in `generation_config.speech_config`. Unary answers are
  WAV, 24 kHz, mono, 16-bit, base64 in `steps[].content[].data`. Language is detected.
  Google's OpenAI-compatible layer has no `/audio/speech`.
- **Free tier (read from the AI Studio rate-limit page):** 3 requests a minute, 10K
  input tokens a minute, **10 requests a day** for each TTS model. Free-tier content is
  used to improve Google's products; paid is not.
- **Paid:** Flash $0.50 in / $9.00 out, Lite $0.50 / $6.00 per 1M tokens through
  2026-12-31, doubled from 2027-01-01. Audio is 25 tokens a second, so a 45 s brief is
  about 1 cent (Lite 0.7 cents), twice that from 2027. Prepay from $5; credits expire
  after 12 months. Since March 2026 the Google Cloud $300 trial credit can't pay for
  the Gemini API. The tier follows the billing account, per linked project.
- **Measured:** 19 calls. Flash 14 to 18 s a brief, Lite 9 to 13 s. Voices tried:
  `callirrhoe`, `zh-cn-techagent-1` (female), `achird`, `zh-cn-concierge-1` (male). The
  builder: the female voices poor, `achird` very good, Lite as good as Flash.

## Decision

Multi-Code keeps one address and one key. An address on `api.cloudflare.com` must be
the MeloTTS model URL and is called in Cloudflare's shape (`prompt`, `lang`, base64
WAV out, no `/health` step in **Test**); any other address is an OpenAI-shaped server as
before (`main/secretary/speech.ts`). Gemini is not wired in: 10 briefs a day free, and
paid on Cloudflare or Google either way.

## Unverified

The exact error and status Cloudflare returns once the daily allocation is used up;
Tier 1 limits for Gemini TTS (only visible signed in to AI Studio).
