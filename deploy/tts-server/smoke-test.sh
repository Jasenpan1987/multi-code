#!/bin/bash
# Run from your own machine, not the server: checks the public endpoint end to end and plays
# one brief.
set -euo pipefail

DOMAIN=${1:?usage: smoke-test.sh <domain> [key file]}
KEY_FILE=${2:-$HOME/.config/qwen-tts/key}
BASE=https://$DOMAIN
OUT=${TMPDIR:-/tmp}/tts-smoke-test.wav

echo "health:       $(curl -s -o /dev/null -w '%{http_code}' "$BASE/health")  (want 200)"
echo "other paths:  $(curl -s -o /dev/null -w '%{http_code}' "$BASE/metrics")  (want 404)"
echo "without key:  $(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d '{"input": "hi"}' "$BASE/v1/audio/speech")  (want 401)"

body=$(python3 -c 'import json; print(json.dumps({
    "input": "审查的 agent 觉得，saveOrder 这个函数可能有问题。两个请求同时进来的时候，订单可能会存两遍。它自己也不确定，想请你看一眼。",
    "voice": "serena",
    "instructions": "用自然、轻松的口语语气，像同事当面跟你汇报工作。",
    "language": "Chinese",
}))')
echo "with key:     $(curl -s -o "$OUT" -w '%{http_code} in %{time_total}s' \
  -H "Authorization: Bearer $(cat "$KEY_FILE")" -H 'Content-Type: application/json' \
  -d "$body" "$BASE/v1/audio/speech")  (want 200)"

if command -v afplay >/dev/null; then afplay "$OUT"; else echo "Audio saved to $OUT"; fi
