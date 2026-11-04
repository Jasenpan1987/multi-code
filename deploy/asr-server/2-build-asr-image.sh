#!/bin/bash
# vLLM's published OpenAI server image plus its audio extra, the way vLLM's Docker docs say to
# add optional dependencies (docs.vllm.ai "Using Docker": FROM vllm/vllm-openai, then
# `uv pip install --system vllm[audio]==<the same version>`). Qwen3-ASR needs the audio
# libraries, which the base image leaves out. The version is the one the TTS's vLLM-Omni
# image is built on, so many layers are shared. Takes 3 to 8 minutes; uses about 20 GB of disk.
set -euo pipefail

VERSION=${VERSION:-0.30.0}

sudo docker pull -q "vllm/vllm-openai:v$VERSION"
got=$(sudo docker run --rm --entrypoint python3 "vllm/vllm-openai:v$VERSION" -c 'import vllm; print(vllm.__version__)')
echo "base image vllm $got"
# The extra must match the base image's vLLM exactly, or pip replaces vLLM itself.
[ "$got" = "$VERSION" ] || { echo "base image is vllm $got, not $VERSION: stop" >&2; exit 1; }

sudo docker build -q -t "asr-vllm:v$VERSION" - <<DOCKERFILE
FROM vllm/vllm-openai:v$VERSION
RUN uv pip install --system "vllm[audio]==$VERSION"
DOCKERFILE
sudo docker run --rm --entrypoint python3 "asr-vllm:v$VERSION" -c 'import vllm, soundfile, av; print("audio ok, vllm", vllm.__version__)'
df -h / | tail -1
