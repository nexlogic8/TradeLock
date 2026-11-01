#!/usr/bin/env bash
# Turn on one static IP per user: route the AWS IPv6 block (a /80 prefix assigned to this server's network interface,
# see the CloudShell command in DEPLOY.md) to this host, let the app send from any address in it, and tell the app.
# Usage on the server: sudo bash deploy/ipv6-pool.sh 2406:da1a:13ae:3200:xxxx::/80   (safe to re-run)
set -euo pipefail
POOL=${1:?usage: ipv6-pool.sh <prefix>/80 or /96}
[[ "$POOL" =~ ^[0-9a-fA-F:]+/(80|96)$ ]] || { echo "expected a /80 (AWS) or /96 (Google Cloud) prefix like 2600:1900:40a0:9b8::/96"; exit 1; }
DIR=$(cd "$(dirname "$0")" && pwd)

# Addresses of the block are local to this host (any of them can be a source address), kept across reboots.
cat > /etc/systemd/system/tradelock-ipv6-pool.service <<EOF
[Unit]
Description=TradeLock per-user IPv6 block ($POOL)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'ip -6 route replace local $POOL dev lo'
ExecStop=/bin/sh -c 'ip -6 route del local $POOL dev lo || true'

[Install]
WantedBy=multi-user.target
EOF
echo 'net.ipv6.ip_nonlocal_bind = 1' > /etc/sysctl.d/60-tradelock-ipv6-pool.conf
sysctl -q --system
systemctl daemon-reload
systemctl enable --now tradelock-ipv6-pool.service
systemctl restart tradelock-ipv6-pool.service

# The app hands out addresses from the block (block + user id).
ENV="$DIR/.env"
if grep -q '^IPV6_POOL=' "$ENV"; then sed -i "s#^IPV6_POOL=.*#IPV6_POOL=$POOL#" "$ENV"; else echo "IPV6_POOL=$POOL" >> "$ENV"; fi
cd "$DIR" && docker compose --env-file .env up -d app
echo "IPv6 block $POOL is live: each user's address is the block plus their user id (e.g. ::7 for user 7)."
