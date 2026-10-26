QuestHR 5.0 · Chandramari Group
================================
Gamified HR task platform: hierarchy, tasks, routines, daily logs with documents,
100 points per completed task, delay reasons with an escalation matrix, team scorecard,
supervisor reviews, conversations, requests, AI assistant and an automatic troubleshooter.
Nothing can ever be deleted.

WHAT IS IN THIS FOLDER
  Install-QuestHR-Windows.bat   Windows 10/11 installer (creates the QuestHR desktop icon)
  install-mac.command           macOS installer (creates QuestHR.app on the Desktop)
  install-linux.sh              Linux installer (applications menu + Desktop icon)
  Start-QuestHR.bat             Windows starter (used by the desktop icon)
  docker-compose.yml, Dockerfile  For a cloud or company server with Docker
  config.json                   Settings: port, data folder, backup folder, AI key
  app/                          The QuestHR app (works offline on the local network)
  server/server.js              The server: database, live sync, files, AI, diagnostics
  icons/                        Desktop and app icons (.ico, .icns, .png)
  tests/validate.js             360-degree validation suite (safe: uses a temporary folder)
  docs/                         Manual and validation report (PDF)

QUICK START (the admin, once)
  1. Install Node.js 22 LTS or newer (the installers try to do this for you): https://nodejs.org/en/download
  2. Windows: double-click Install-QuestHR-Windows.bat
     macOS:   right-click install-mac.command > Open
     Linux:   sh install-linux.sh
     Docker:  docker compose up -d
  3. The QuestHR icon appears on the Desktop and the app opens at http://localhost:8080
  4. Choose "Set up your organisation" (or load the sample), add localities with their
     Wi-Fi passwords, levels, units and members.
  5. Share the server address shown in the server window (for example http://192.168.1.20:8080)
     with staff. Each member opens it, signs in, then Help > Desktop icon to add the icon.

GOOGLE DRIVE PILOT, THEN YOUR SERVER
  - During the pilot the installers put the backups and the audit journal in
    Google Drive for desktop (folder "QuestHR-Backups"), so every change is copied to Drive
    every hour. The live database stays on the computer's own disk, because a database that is
    being written must not sit inside a syncing folder.
  - To move to the final server after validation: install QuestHR on the server, stop the pilot,
    copy the pilot data folder (shown in the server window) to the server's data folder,
    start QuestHR there and share the new address. Nothing is lost: the audit journal holds
    every change ever made.

VALIDATE ON YOUR OWN COMPUTER OR SERVER
  node tests/validate.js
  It starts a temporary server, signs several people in at once and checks sync, access rules,
  scoring, escalation, conversations, files, "nothing can be deleted", login security,
  restart and automatic recovery. Your real data is never touched.

TROUBLESHOOTING
  - In the app: Help > Run checks. Fixes never change or delete stored records.
  - On the server: node server/server.js --doctor   (checks + safe repairs + a backup)
  - Port in use: QuestHR is probably already running; open http://localhost:8080
  - Other computers cannot connect: allow port 8080 in the firewall; use the network address
    printed in the server window, not "localhost".
  - Damaged database: just restart. The server keeps the damaged copy, restores the newest
    backup and replays every later change from the audit journal.

AI
  Put your Anthropic API key in config.json ("anthropicApiKey") and restart.
  Default models: claude-sonnet-5-5 (answers) and claude-haiku-5-5 (quick summaries).
  Without a key everything else works; AI buttons explain that AI is off.
