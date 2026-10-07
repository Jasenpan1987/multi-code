#!/bin/bash
# Qwen3-TTS under vLLM-Omni's published image, with the launch command from vLLM-Omni's own
# example: examples/online_serving/text_to_speech/qwen3_tts/run_server.sh (v0.30.0).
# Safe to re-run: it replaces the container, keeps the key and the downloaded weights.
set -euo pipefail

IMAGE=${IMAGE:-vllm/vllm-omni:v0.30.0}
MODEL=${MODEL:-Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice}
# Share of the GPU's memory this server claims. Lower it (about 0.45) before putting a second
# model, such as speech-to-text, on the same card.
GPU_MEMORY=${GPU_MEMORY:-0.9}

# The API key is generated once, on this machine, and never printed. vLLM reads VLLM_API_KEY.
if ! sudo test -f /etc/qwen-tts/env; then
  sudo install -d -m 700 /etc/qwen-tts
  echo "VLLM_API_KEY=$(openssl rand -hex 32)" | sudo tee /etc/qwen-tts/env >/dev/null
  sudo chmod 600 /etc/qwen-tts/env
fi

sudo docker rm -f qwen-tts >/dev/null 2>&1 || true
# --restart unless-stopped brings the server back by itself after the instance is stopped and
# started. The weights live on the root volume, so they survive that too. 127.0.0.1 only:
# Caddy is the one thing allowed to reach it.
sudo docker run -d --name qwen-tts --restart unless-stopped --runtime nvidia --gpus all --ipc=host \
  --env-file /etc/qwen-tts/env \
  -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
  -p 127.0.0.1:8091:8091 \
  "$IMAGE" \
  vllm-omni serve "$MODEL" \
    --deploy-config /app/vllm-omni/vllm_omni/deploy/qwen3_tts.yaml \
    --host 0.0.0.0 --port 8091 --gpu-memory-utilization "$GPU_MEMORY" --trust-remote-code --omni

echo "Waiting for the model to load. The first run also downloads ~10 GB of image and ~4.5 GB of weights."
for _ in $(seq 1 90); do
  if curl -sf -o /dev/null localhost:8091/health; then
    echo READY
    exit 0
  fi
  sleep 10
done
echo "Not ready after 15 minutes. See: sudo docker logs qwen-tts" >&2
exit 1
