# Kallipolis — agent instructions

- Read `AGENT_MAP.md` first; it describes every file. Open only what the task needs.
- Never list or search `.git/` or `assets/models/`.
- Grep for symbols and read line ranges; don't read files marked **big** in the map whole.
- No build step: plain ES modules served from the repo root (`python3 serve.py [port]`).
- CSS lives in `css/` (cascade order: base, win3, touch, phone, ped) plus `src/ui/meter.css`.
- Keep `AGENT_MAP.md` in sync when adding, moving or removing files.
- When adding death causes, traits, world values, building kinds or other events people could notice, update the speech system to match (see the speech rule in `AGENT_MAP.md`).
