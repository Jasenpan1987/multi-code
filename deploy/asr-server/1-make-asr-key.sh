#!/bin/bash
# The speech-to-text server's own API key, separate from the TTS's, so a client of one never
# holds the other's. Generated once, on this machine, never printed. vLLM reads VLLM_API_KEY;
# the other two lines turn off vLLM's anonymous usage reporting, so the server sends nothing
# out on its own (https://docs.vllm.ai/en/latest/usage/usage_stats.html).
set -euo pipefail

if ! sudo test -f /etc/asr/env; then
  sudo install -d -m 700 /etc/asr
  printf 'VLLM_API_KEY=%s\nVLLM_NO_USAGE_STATS=1\nDO_NOT_TRACK=1\n' "$(openssl rand -hex 32)" \
    | sudo tee /etc/asr/env >/dev/null
  sudo chmod 600 /etc/asr/env
fi
# Names only, never values.
sudo cut -d= -f1 /etc/asr/env
