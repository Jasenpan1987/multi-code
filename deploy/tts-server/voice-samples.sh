#!/bin/bash
# Run from your own machine: every voice the server offers, saying the same brief in Chinese
# and in English, saved as <voice>_<zh|en>.wav for picking a voice by ear.
set -euo pipefail

DOMAIN=${1:?usage: voice-samples.sh <domain> [key file] [output dir]}
KEY_FILE=${2:-$HOME/.config/qwen-tts/key}
OUT=${3:-${TMPDIR:-/tmp}/tts-voices}
URL=https://$DOMAIN/v1/audio
KEY=$(cat "$KEY_FILE")
mkdir -p "$OUT"

ZH="你好，我是你的秘书。MSK 那边做完了，测试全部通过，有一个小问题等你来定。"
EN="Hi, I'm your secretary. MSK just finished, all the tests pass, and there's one small thing waiting for your call."
ZH_STYLE="用自然、轻松的口语语气，像同事当面跟你汇报工作。"
EN_STYLE="Speak in a natural, relaxed conversational tone, like a colleague briefing you in person."

voices=$(curl -sf -H "Authorization: Bearer $KEY" "$URL/voices" \
  | python3 -c 'import json, sys; print(" ".join(json.load(sys.stdin)["voices"]))')
echo "voices: $voices"

for voice in $voices; do
  for lang in zh en; do
    if [ "$lang" = zh ]; then
      text=$ZH style=$ZH_STYLE language=Chinese
    else
      text=$EN style=$EN_STYLE language=English
    fi
    body=$(python3 -c 'import json, sys; print(json.dumps({"input": sys.argv[1], "voice": sys.argv[2], "instructions": sys.argv[3], "language": sys.argv[4]}))' \
      "$text" "$voice" "$style" "$language")
    code=$(curl -s -o "$OUT/${voice}_${lang}.wav" -w '%{http_code}' -H "Authorization: Bearer $KEY" \
      -H 'Content-Type: application/json' -d "$body" "$URL/speech")
    echo "$voice $lang: $code"
  done
done
echo "Saved to $OUT. Play them with: for f in $OUT/*.wav; do echo \$f; afplay \$f; done"
