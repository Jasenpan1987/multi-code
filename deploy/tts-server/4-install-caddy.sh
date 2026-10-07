#!/bin/bash
# Caddy in front of the model server: HTTPS for your domain, with a certificate Caddy obtains
# and renews from Let's Encrypt on its own. The domain's A record must already point here.
set -euo pipefail

DOMAIN=${1:?usage: 4-install-caddy.sh <domain, e.g. tts.example.com>}

# Official apt install: https://caddyserver.com/docs/install#debian-ubuntu-raspbian
sudo apt install --yes debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install --yes caddy

# The package runs Caddy as a systemd service that reads /etc/caddy/Caddyfile.
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
	# vLLM-Omni serves many routes (robot policies, video, metrics). Expose only speech and
	# the health check; everything else is a 404 before it reaches the model server.
	@api path /v1/audio/* /health
	handle @api {
		# -1 passes every write straight through, so streamed audio isn't held in a buffer.
		reverse_proxy 127.0.0.1:8091 {
			flush_interval -1
		}
	}
	handle {
		respond 404
	}
}
EOF
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
