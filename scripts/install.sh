#!/bin/bash
#
# Elevant Monitoring Agent — Quick Install
#
# Run on a fresh Ubuntu 22.04/24.04 VM:
#   curl -fsSL https://raw.githubusercontent.com/bizgroup-dev/elevant-agent/main/scripts/install.sh | bash
#
# Or locally:
#   bash scripts/install.sh
#
# What it does:
#   1. Installs Bun runtime
#   2. Clones the agent repo
#   3. Installs dependencies
#   4. Creates config from template (edit before starting)
#   5. Installs systemd service
#   6. Prints next steps
#

set -e

INSTALL_DIR="/opt/elevant-agent"
SERVICE_NAME="elevant-agent"
REPO="https://github.com/bizgroup-dev/elevant-agent.git"

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   Elevant Monitoring Agent — Installer   ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash install.sh"
  exit 1
fi

# --- Step 1: Install Bun ---
echo "[1/5] Installing Bun runtime..."
if command -v bun &> /dev/null; then
  echo "  Bun already installed: $(bun --version)"
else
  curl -fsSL https://bun.sh/install | bash
  # Add to path for this session
  export BUN_INSTALL="/root/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  # Also add for the service user
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun 2>/dev/null || true
  echo "  Bun installed: $(bun --version)"
fi

# --- Step 2: Clone repo ---
echo "[2/5] Setting up agent at $INSTALL_DIR..."
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Agent already exists, pulling latest..."
  cd "$INSTALL_DIR" && git pull
else
  rm -rf "$INSTALL_DIR"
  # Private repo — needs authentication
  echo "  The agent repo is private. You'll need GitHub credentials."
  echo "  Use a personal access token (Settings → Developer settings → Tokens)"
  echo ""
  read -p "  GitHub username: " GH_USER
  read -sp "  GitHub token: " GH_TOKEN
  echo ""
  git clone "https://${GH_USER}:${GH_TOKEN}@github.com/bizgroup-dev/elevant-agent.git" "$INSTALL_DIR"
  # Store credentials for future pulls
  cd "$INSTALL_DIR"
  git remote set-url origin "https://${GH_USER}:${GH_TOKEN}@github.com/bizgroup-dev/elevant-agent.git"
fi

cd "$INSTALL_DIR"

# --- Step 3: Install dependencies ---
echo "[3/5] Installing dependencies..."
bun install

# --- Step 4: Create config ---
echo "[4/5] Setting up configuration..."
if [ ! -f config/config.json ]; then
  cp config/config.template.json config/config.json
  echo "  Created config/config.json from template"
  echo ""
  echo "  ⚠️  IMPORTANT: Edit config/config.json before starting!"
  echo "     sudo nano $INSTALL_DIR/config/config.json"
  echo ""
  echo "  Required settings:"
  echo "    - site.id        → unique site identifier (e.g., 'customer-name')"
  echo "    - site.name      → human-readable name"
  echo "    - unifi.host     → IP of the UniFi Dream Machine"
  echo "    - unifi.username  → UniFi local account"
  echo "    - unifi.password  → UniFi local password"
  echo "    - elevant.url    → Elevant server URL"
  echo "    - elevant.apiKey → Agent API key (from Elevant admin)"
  echo ""
else
  echo "  config/config.json already exists, keeping it"
fi

# --- Step 5: Install systemd service ---
echo "[5/5] Installing systemd service..."
cat > /etc/systemd/system/${SERVICE_NAME}.service << SYSTEMD
[Unit]
Description=Elevant Monitoring Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/local/bin/bun run src/agent.ts
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$INSTALL_DIR/data $INSTALL_DIR/config
PrivateTmp=true

[Install]
WantedBy=multi-user.target
SYSTEMD

systemctl daemon-reload
systemctl enable $SERVICE_NAME

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║          Installation Complete!          ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Edit the config:"
echo "     sudo nano $INSTALL_DIR/config/config.json"
echo ""
echo "  2. Start the agent:"
echo "     sudo systemctl start $SERVICE_NAME"
echo ""
echo "  3. Check status:"
echo "     sudo systemctl status $SERVICE_NAME"
echo "     sudo journalctl -u $SERVICE_NAME -f"
echo ""
echo "  4. Update agent:"
echo "     cd $INSTALL_DIR && sudo git pull && sudo bun install"
echo "     sudo systemctl restart $SERVICE_NAME"
echo ""
echo "  Agent location: $INSTALL_DIR"
echo "  Config file:    $INSTALL_DIR/config/config.json"
echo "  Service:        systemctl {start|stop|status|restart} $SERVICE_NAME"
echo "  Logs:           journalctl -u $SERVICE_NAME -f"
echo ""
