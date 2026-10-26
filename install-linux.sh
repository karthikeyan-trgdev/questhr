#!/bin/sh
# QuestHR installer for Linux · adds QuestHR to the applications menu and Desktop, optional auto-start
cd "$(dirname "$0")"; PKG="$(pwd)"
echo; echo "  QuestHR · Chandramari Group"; echo "  Installing from $PKG"; echo
M=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')
if [ -z "$M" ] || [ "$M" -lt 22 ]; then echo "Node.js 22 or newer is needed: https://nodejs.org/en/download (or your package manager)."; (xdg-open https://nodejs.org/en/download >/dev/null 2>&1 &); exit 1; fi
echo "Node.js $(node -v) found."
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/questhr/data"; mkdir -p "$DATA"
DRIVE="$(node server/configure.js --detect-drive)"
if [ -n "$DRIVE" ]; then mkdir -p "$DRIVE/QuestHR-Backups"; node server/configure.js --data "$DATA" --backup "$DRIVE/QuestHR-Backups"; else node server/configure.js --data "$DATA"; fi
cat > "$PKG/start-questhr.sh" <<EOF
#!/bin/sh
cd "$PKG"
PORT=\$(node -e "try{console.log(require('./config.json').port||8080)}catch(e){console.log(8080)}")
if ! curl -fs "http://localhost:\$PORT/api/health" >/dev/null 2>&1; then nohup node server/server.js >> server.log 2>&1 & sleep 2; fi
[ "\$1" = "nobrowser" ] || xdg-open "http://localhost:\$PORT"
EOF
chmod +x "$PKG/start-questhr.sh"
mkdir -p "$HOME/.local/share/applications"
F="$HOME/.local/share/applications/questhr.desktop"
printf '[Desktop Entry]\nType=Application\nName=QuestHR\nComment=Chandramari Group HR tasks\nExec=%s/start-questhr.sh\nIcon=%s/icons/questhr-256.png\nTerminal=false\nCategories=Office;\n' "$PKG" "$PKG" > "$F"
chmod +x "$F"
D=$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")
if [ -d "$D" ]; then cp "$F" "$D/"; chmod +x "$D/questhr.desktop"; gio set "$D/questhr.desktop" metadata::trusted true 2>/dev/null || true; fi
echo "QuestHR added to the applications menu and Desktop."
printf "Start the QuestHR server automatically at login? [y/N] "; read A
case "$A" in [Yy]*) if command -v systemctl >/dev/null; then mkdir -p "$HOME/.config/systemd/user"
  printf '[Unit]\nDescription=QuestHR server\n[Service]\nWorkingDirectory=%s\nExecStart=%s server/server.js\nRestart=on-failure\n[Install]\nWantedBy=default.target\n' "$PKG" "$(command -v node)" > "$HOME/.config/systemd/user/questhr.service"
  systemctl --user daemon-reload && systemctl --user enable --now questhr.service && echo "Auto-start enabled."; fi;; esac
"$PKG/start-questhr.sh"
