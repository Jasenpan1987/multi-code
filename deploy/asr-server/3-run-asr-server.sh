#!/bin/bash
# Qwen3-ASR-1.7B under vLLM's OpenAI server, the serving path Qwen's own README gives
# (`vllm serve Qwen/Qwen3-ASR-1.7B`, OpenAI /v1/audio/transcriptions), in vLLM's documented
# container form. Shares the GPU with the TTS (deploy/tts-server/), so two limits are set:
#
# - ASR_MEMORY, its share of the card. 0.30 was planned and failed on the L4 with "No
#   available memory for the cache blocks"; 0.50 gives 4.4 GiB of KV cache (about ten
#   4,096-token requests at once) next to the TTS's 7.3 GB. Needs the TTS on its per-stage
#   shares first (deploy/tts-server/3-run-model-server.sh), or vLLM refuses to start.
# - MAX_MODEL_LEN. The model's 65,536-token default needs more KV cache than the share holds.
#
# Safe to re-run: it replaces the container and keeps the key and the downloaded weights.
# The first run downloads 4.7 GB of weights and compiles: 5 to 10 minutes.
set -euo pipefail

IMAGE=${IMAGE:-asr-vllm:v0.30.0}
MODEL=${MODEL:-Qwen/Qwen3-ASR-1.7B}
ASR_MEMORY=${ASR_MEMORY:-0.50}
MAX_MODEL_LEN=${MAX_MODEL_LEN:-4096}

sudo docker rm -f qwen-asr >/dev/null 2>&1 || true
# --restart unless-stopped brings it back after the instance is stopped and started.
# 127.0.0.1 only: Caddy is the one thing allowed to reach it.
sudo docker run -d --name qwen-asr --restart unless-stopped --runtime nvidia --gpus all --ipc=host \
  --env-file /etc/asr/env \
  -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
  -v qwen-asr-vllm-cache:/root/.cache/vllm \
  -p 127.0.0.1:8092:8000 \
  "$IMAGE" \
  --model "$MODEL" \
  --gpu-memory-utilization "$ASR_MEMORY" \
  --max-model-len "$MAX_MODEL_LEN" >/dev/null

echo "Waiting for the model to load (the first run downloads 4.7 GB of weights)."
for _ in $(seq 1 90); do
  if curl -sf -o /dev/null localhost:8092/health; then
    echo READY
    sudo docker logs qwen-asr 2>&1 | grep -E "Available KV cache memory|Maximum concurrency" | tail -2
    sudo nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
    exit 0
  fi
  if sudo docker logs qwen-asr 2>&1 | grep -q "Engine core initialization failed"; then
    sudo docker logs qwen-asr 2>&1 | grep -E "Error|error:" | tail -3 >&2
    echo "It failed to start; see Troubleshooting in deploy/asr-server/README.md" >&2
    exit 1
  fi
  sleep 10
done
echo "Not ready after 15 minutes. See: sudo docker logs qwen-asr" >&2
exit 1
