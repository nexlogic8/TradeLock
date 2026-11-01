#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu 22.04/24.04 server (Lightsail or EC2). Run as the default user with sudo.
set -euo pipefail

echo "==> Installing Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

echo "==> Adding 1 GB swap (helps small instances during image builds)"
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> Setting timezone to IST (logs line up with market hours)"
sudo timedatectl set-timezone Asia/Kolkata

echo "==> Enabling automatic security updates"
sudo apt-get update -y && sudo apt-get install -y unattended-upgrades sqlite3
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Daily database backup at 16:30 IST (after market close)"
mkdir -p "$HOME/backups"
( crontab -l 2>/dev/null | grep -v tradelock-backup; echo "30 16 * * * $HOME/tradelock/deploy/backup.sh >> $HOME/backups/backup.log 2>&1 # tradelock-backup" ) | crontab -

echo "Done. Log out and back in (for docker group), then run: cd ~/tradelock/deploy && ./deploy.sh"
