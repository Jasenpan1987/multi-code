#!/bin/bash
# End-to-end check of the speech-to-text server from the Mac (deploy/asr-server/README.md, step 10).
# Copies the ASR key to ~/.config/asr/key on first run, without showing it. Test clips are made
# up and spoken by the TTS server, so nothing sensitive is sent (Sounds Good's test-bed rule).
#
# usage: deploy/asr-server/smoke-test.sh [ssh key] [ssh host]
set -euo pipefail

SSH_KEY=${1:-~/.ssh/tts-poc-oregon.pem}
SSH_HOST=${2:-ubuntu@tts.jasenpan.com}
ASR=https://asr.jasenpan.com
TTS=https://tts.jasenpan.com
MODEL=Qwen/Qwen3-ASR-1.7B

if [ ! -s ~/.config/asr/key ]; then
  mkdir -p ~/.config/asr
  (umask 077; ssh -i "$SSH_KEY" "$SSH_HOST" 'sudo sed -n "s/^VLLM_API_KEY=//p" /etc/asr/env' > ~/.config/asr/key)
  echo "key copied to ~/.config/asr/key ($(wc -c < ~/.config/asr/key | tr -d ' ') bytes, $(stat -f %Sp ~/.config/asr/key))"
fi

# Headers through a pipe, so neither key is printed or visible in ps.
asr_auth() { printf 'Authorization: Bearer %s' "$(cat ~/.config/asr/key)"; }
tts_auth() { printf 'Authorization: Bearer %s' "$(cat ~/.config/qwen-tts/key)"; }
T=$(mktemp -d)

echo "health:      $(curl -s -o /dev/null -w '%{http_code}' $ASR/health)  (want 200)"
echo "other paths: $(curl -s -o /dev/null -w '%{http_code}' $ASR/invocations)  (want 404)"
echo "without key: $(curl -s -o /dev/null -w '%{http_code}' -F file=@/dev/null $ASR/v1/audio/transcriptions)  (want 401)"

say_clip() {
  python3 -I -c 'import json, sys; print(json.dumps({"input": sys.argv[1], "voice": "serena", "language": sys.argv[2], "response_format": "wav"}))' "$2" "$3" \
    | curl -s -H @<(tts_auth) -H 'Content-Type: application/json' -d @- $TTS/v1/audio/speech -o "$T/$1.wav"
}
echo "making test clips with the TTS server…"
say_clip short   "你去把这个 PR 给我 merge 一下。" Chinese
say_clip medium  "后天的会先讲 deployment，然后看一下 UVAP 的 PR。如果测试都过了，我们周五就可以 release。" Chinese
say_clip long    "今天早上 staging 的 deploy 失败了两次，我看了一下 log，好像是 database migration 的问题。你先帮我把那个 PR revert 掉，然后跑一遍 integration test。如果还是不行，我们下午开个短会，把 rollback 的方案定下来，顺便看一下 UVAP 那边的 API 有没有变化。" Chinese
say_clip english "Can you take a look at the pull request for the billing service before lunch? The tests pass locally, but the staging deploy failed twice this morning." English

for clip in short medium long english; do
  echo "== $clip"
  for run in 1 2 3; do
    curl -s -w "  [run $run: %{http_code} in %{time_total}s]\n" -H @<(asr_auth) \
      -F file=@"$T/$clip.wav" -F model=$MODEL $ASR/v1/audio/transcriptions
  done
done

echo "== medium, with the prompt \"UVAP, Multi-Code\""
curl -s -w "  [%{http_code} in %{time_total}s]\n" -H @<(asr_auth) \
  -F file=@"$T/medium.wav" -F model=$MODEL -F prompt="UVAP, Multi-Code" $ASR/v1/audio/transcriptions

rm -rf "$T"
