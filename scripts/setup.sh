#!/bin/bash
# ──────────────────────────────────────────────────────────────────
# Elevant Monitoring Agent — Setup Script
#
# Turns a fresh Ubuntu 24.04 machine into a monitoring agent.
# Run as root:
#   sudo bash scripts/setup.sh
#
# After running, edit /etc/elevant-agent/config.json with site-specific
# values (UDM IP, credentials, site name), then:
#   sudo systemctl restart elevant-agent
# ──────────────────────────────────────────────────────────────────

set -euo pipefail

echo "═══════════════════════════════════════════"
echo "  Elevant Monitoring Agent — Setup"
echo "═══════════════════════════════════════════"

# Check root
if [ "$EUID" -ne 0 ]; then
  echo "ERROR: Run as root (sudo bash scripts/setup.sh)"
  exit 1
fi

# ── 1. System updates ──
echo ""
echo "[1/7] System updates..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl unzip unattended-upgrades ufw

# ── 2. Firewall ──
echo "[2/7] Configuring firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw --force enable
echo "  Firewall: SSH inbound allowed, all outbound allowed"

# ── 3. Install Bun ──
echo "[3/7] Installing Bun..."
if command -v bun &> /dev/null; then
  echo "  Bun already installed: $(bun --version)"
else
  curl -fsSL https://bun.sh/install | bash
  # Make bun available system-wide
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun
  echo "  Bun installed: $(bun --version)"
fi

# ── 4. Create agent user ──
echo "[4/7] Creating agent user..."
if id "elevant-agent" &>/dev/null; then
  echo "  User elevant-agent already exists"
else
  useradd -r -s /bin/false -d /opt/elevant-agent elevant-agent
  echo "  Created system user: elevant-agent"
fi

# ── 5. Deploy agent code ──
echo "[5/7] Deploying agent..."
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p /opt/elevant-agent
# Copy agent code from source directory
cp -r "$SCRIPT_DIR/src" "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/tsconfig.json" /opt/elevant-agent/
cp -r "$SCRIPT_DIR/config" "$SCRIPT_DIR/scripts" "$SCRIPT_DIR/systemd" /opt/elevant-agent/
# Install dependencies (if any in future)
cd /opt/elevant-agent && bun install --production 2>/dev/null || true
chown -R elevant-agent:elevant-agent /opt/elevant-agent
echo "  Agent deployed to /opt/elevant-agent"

# ── 6. Config ──
echo "[6/7] Setting up configuration..."
mkdir -p /etc/elevant-agent
if [ ! -f /etc/elevant-agent/config.json ]; then
  cp "$SCRIPT_DIR/config/config.json" /etc/elevant-agent/config.json
  chmod 600 /etc/elevant-agent/config.json
  chown elevant-agent:elevant-agent /etc/elevant-agent/config.json
  echo "  Config template copied to /etc/elevant-agent/config.json"
  echo "  >>> EDIT THIS FILE with site-specific values before starting <<<"
else
  echo "  Config already exists, not overwriting"
fi

# ── 7. Systemd service ──
echo "[7/7] Installing systemd service..."
cp "$SCRIPT_DIR/systemd/elevant-agent.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable elevant-agent
echo "  Service installed and enabled (auto-start on boot)"

echo ""
echo "═══════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Next steps:"
echo "  1. Edit config:  sudo nano /etc/elevant-agent/config.json"
echo "     - Set unifi.password"
echo "     - Set elevant.apiKey (when available)"
echo "  2. Start agent:  sudo systemctl start elevant-agent"
echo "  3. Check status:  sudo systemctl status elevant-agent"
echo "  4. View logs:    sudo journalctl -u elevant-agent -f"
echo "═══════════════════════════════════════════"
