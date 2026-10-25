# Hockey Tracker

Mobile-first PWA for capturing a youth hockey game: dictated notes, shifts/ice time, face-offs, quick stats.
Everything is one timestamped event log (period + game clock + wall time) so Claude can analyze it after the game.

## Run
    docker compose up -d --build      # http://<host>:3000, data in ./data

Voice dictation (Web Speech API) needs **HTTPS** on iPhone — put it behind your reverse proxy / Tailscale serve.
Without HTTPS, use the 🎙 key on the iOS keyboard in the note box. Then "Add to Home Screen".

## Using it in a game
- **Notes**: tap 🎙, talk, tap again (auto-saves). Timestamp = when you *started* talking. Optional "about" chips; no categorizing.
  Each note also records who was on the ice.
- **Ice**: tap a player on/off. Hold = note about that player. Time accrues only while the game clock runs (wall-time TOI is also kept).
- **Faceoff**: pick center + zone once, then one tap per result (clean/scrappy win/loss).
- **Stats**: pick player, tap to +1, hold to attach a note.

## Offline (rinks with no signal)
Open the app once online after installing/updating so it caches itself; after that it launches with no connection.
Everything is saved on the device first and synced in the background (header shows "Offline · saved on device" / "⟳ N unsynced"):
notes, shifts, faceoffs, stats, clock, lines, starting a new game, roster edits (number/position/★/remove), reopening
recent games, and markdown export/download. Needs a connection: adding/importing players, the first load of a game on a new device.

## Claude / Obsidian
    claude mcp add --transport http hockey http://<host>:3000/mcp
Tools: `list_games`, `get_game` (Obsidian-ready markdown), `search_notes`, `player_report`, `faceoff_report`.
Or download `/api/games/<id>/export.md`. Set `MCP_TOKEN` to require a bearer token on `/mcp` (the web UI/API itself has no auth — keep it on LAN/VPN).
