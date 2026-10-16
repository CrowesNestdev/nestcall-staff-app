# Nest Call – Staff App (Windows)

Receives table calls in real time and pops up an always-on-top alert with a sound.
Customers install it with a normal one-click installer; **they do not need Node.js or anything else.**

## For you (the developer): build the installer once

Needs Node.js 20+ on your build PC only.

```
npm install
npm start          # try it out (opens the app)
npm run dist       # builds dist\NestCall-Setup-1.0.0.exe
```

Give customers that single `.exe`. It installs per-user (no admin rights), adds a Start menu
shortcut, starts with Windows, and runs in the system tray.

Don't want Node on your PC at all? Push this folder to a GitHub repo, open the **Actions** tab,
run **Build Windows installer**, and download the finished `.exe` from the run's artifacts.

## For staff

1. Run `NestCall-Setup-1.0.0.exe` (Windows may show a "SmartScreen" warning until the app is code-signed – choose *More info → Run anyway*).
2. Sign in with the email and password from your manager.
3. Pick your site(s). Done – leave it running. Closing the window keeps it in the tray.

## Behaviour

- New calls pop up on top of all windows **without stealing keyboard focus** (so a stray Enter key can't accept a call). Click to interact.
- **Accept**: first person to accept wins; others' popups clear automatically.
- **False alarm**: optionally disables the table (15 min / 1 hour / rest of today / until turned back on) and blocks the caller's phone for an hour.
- Unanswered calls re-alert (default every 60 s, adjustable in Settings).
- Warns when the connection is lost; on reconnect it catches up on any calls it missed.
- Tray icon turns red while calls are waiting. Tray menu: open, test alert, start with Windows, sign out, quit.

## Files

- `src/config.js` – Supabase URL + publishable key (safe to embed; RLS protects the data)
- `src/main.js` – sign-in, realtime connection, windows, tray
- `src/renderer/` – the settings window and the call popup
