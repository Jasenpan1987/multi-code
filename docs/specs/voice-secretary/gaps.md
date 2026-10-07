# Gaps: Voice Secretary

| ID | Question | Impact | Ask | Status |
|-------|-------------------------------|--------------------------|-----------------|--------|

## Resolved

| ID | Question | Resolution | Evidence |
|-------|-------------------------------|--------------------------|-----------------|
| G-003 | Briefs quote the builder's working code, often company code, and the voice runs in the builder's personal AWS account. Acceptable for company repositories? | Not used on company projects for now. During the POC the builder uses Secretary Mode on personal projects only; revisit when the server moves to the company account. | Builder, 2026-10-07, in session |
| G-002 | Which language model writes the brief from the transcript? | Claude Sonnet 5.5 on the company's Bedrock, `global.anthropic.claude-sonnet-5-5`, through the Bedrock access Claude Code already uses on the Mac (the AWS profile and region set in `~/.claude/settings.json` `env`). `au.anthropic.claude-sonnet-5-5` doesn't exist, so requests may be served outside Australia. | Builder, 2026-10-07, in session. Verified the same day: `aws bedrock-runtime converse --model-id global.anthropic.claude-sonnet-5-5` from the Mac answered in 1,739 ms (42 input, 16 output tokens); the `au.` id returned "The provided model identifier is invalid" |
| G-001 | Which voice engine and voice? | Qwen3-TTS-12Hz-1.7B-CustomVoice, voice Serena for Chinese and English, served by vLLM-Omni on a GPU server at `https://tts.jasenpan.com/v1/audio/speech` (OpenAI speech API shape). Not on the user's Mac (6–7 GB peak). The `language` sent with each brief follows the language of the user's latest message in that session. | Builder, 2026-10-07, after listening tests; `docs/timeline/2026-10-07_voice-engine-hosting.md` |
