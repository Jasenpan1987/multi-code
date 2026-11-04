#!/bin/bash
# Two checks on the server itself, before HTTPS is involved.
#
# 1. Qwen's own sample (the Qwen3-ASR README's asr_zh.wav). Expected text:
#    甚至出现交易几乎停滞的情况。 Measured 2026-10-08: exact, in 0.24 s.
# 2. The TTS's GPU use while it works hardest: four long briefs, two at once. Measured
#    2026-10-08: 7,280 MiB peak against 7,278 idle. A peak far above idle would eat the
#    ASR's room; lower ASR_MEMORY in 3-run-asr-server.sh to match.
set -euo pipefail

curl -sfL -o /tmp/asr_zh.wav https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-ASR-Repo/asr_zh.wav
sudo bash -c '. /etc/asr/env; curl -s -w "\n%{http_code} in %{time_total}s\n" localhost:8092/v1/audio/transcriptions \
  -H "Authorization: Bearer $VLLM_API_KEY" -F file=@/tmp/asr_zh.wav -F model=Qwen/Qwen3-ASR-1.7B'

cat > /tmp/zh.json <<'J'
{"input": "Multi-Code 那边做完了。你让它给秘书模式加一个自动调音量的功能，它已经改好了，每条简报播放前会先算一下响度，太小就自动放大，而且不会破音。自动测试全部通过，一共九百九十五个。还没提交，等你听一下效果再决定。", "voice": "serena", "response_format": "wav"}
J
cat > /tmp/en.json <<'J'
{"input": "eat-what just finished. You asked it to add a weekly meal planner, and it did: the planner page now suggests seven dinners from your saved recipes, avoids repeating anything from last week, and lets you swap a day with one tap. All tests pass, and it is waiting for you to try it.", "voice": "serena", "response_format": "wav"}
J
TTS_KEY=$(sudo sed -n 's/^VLLM_API_KEY=//p' /etc/qwen-tts/env)
speak() {
  curl -s -o "/tmp/$2.wav" -w "TTS $2: %{http_code} in %{time_total}s\n" localhost:8091/v1/audio/speech \
    -H "Authorization: Bearer $TTS_KEY" -H 'Content-Type: application/json' -d "@/tmp/$1.json"
}
sudo timeout 90 nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits -lms 200 > /tmp/gpu.log &
sleep 2
speak zh one
speak en two
speak zh three & speak en four & wait %2 %3 2>/dev/null || wait
sudo pkill -f "nvidia-smi --query-gpu=memory.used" || true
echo "GPU peak MiB: $(sort -n /tmp/gpu.log | tail -1), idle MiB: $(head -1 /tmp/gpu.log)"
