#!/bin/bash
# QuestHR installer for macOS · creates QuestHR.app on the Desktop and starts the server
cd "$(dirname "$0")"; PKG="$(pwd)"
echo; echo "  QuestHR · Chandramari Group"; echo "  Installing from $PKG"; echo
major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'; }
if [ -z "$(major)" ] || [ "$(major)" -lt 22 ]; then
  if command -v brew >/dev/null; then echo "Installing Node.js with Homebrew..."; brew install node@22 && brew link --overwrite --force node@22; fi
  if [ -z "$(major)" ] || [ "$(major)" -lt 22 ]; then echo "Please install Node.js LTS from the page that opens, then run this installer again."; open "https://nodejs.org/en/download"; exit 1; fi
fi
echo "Node.js $(node -v) found."
DATA="$HOME/Library/Application Support/QuestHR/data"; mkdir -p "$DATA"
DRIVE="$(node server/configure.js --detect-drive)"
if [ -n "$DRIVE" ]; then
  read -r -p "Google Drive for desktop found at $DRIVE. Keep QuestHR backups there for the pilot? [Y/n] " A
  if [ -z "$A" ] || [[ "$A" =~ ^[Yy] ]]; then mkdir -p "$DRIVE/QuestHR-Backups"; node server/configure.js --data "$DATA" --backup "$DRIVE/QuestHR-Backups"; else node server/configure.js --data "$DATA"; fi
else
  echo "Google Drive for desktop not found (https://www.google.com/drive/download/). Backups stay next to the data."; node server/configure.js --data "$DATA"
fi
NODE="$(command -v node)"
for APP in "$HOME/Desktop/QuestHR.app" "$HOME/Applications/QuestHR.app"; do
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp icons/questhr.icns "$APP/Contents/Resources/questhr.icns"
  cat > "$APP/Contents/MacOS/QuestHR" <<EOF
#!/bin/bash
cd "$PKG"
PORT=\$("$NODE" -e "try{console.log(require('./config.json').port||8080)}catch(e){console.log(8080)}")
if ! curl -fs "http://localhost:\$PORT/api/health" >/dev/null; then nohup "$NODE" server/server.js >> server.log 2>&1 & sleep 2; fi
open "http://localhost:\$PORT"
EOF
  chmod +x "$APP/Contents/MacOS/QuestHR"
  cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>QuestHR</string><key>CFBundleDisplayName</key><string>QuestHR</string>
<key>CFBundleExecutable</key><string>QuestHR</string><key>CFBundleIconFile</key><string>questhr</string>
<key>CFBundleIdentifier</key><string>com.chandramari.questhr</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>5.0</string>
</dict></plist>
EOF
  touch "$APP"
done
echo "QuestHR.app added to your Desktop and Applications."
"$HOME/Desktop/QuestHR.app/Contents/MacOS/QuestHR"
