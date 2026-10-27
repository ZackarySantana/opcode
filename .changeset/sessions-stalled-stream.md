---
"@lidtop/opencode-sessions": patch
---

The Agents sidebar no longer freezes when its event stream silently stops delivering, which left finished sessions listed as working, missed new ones, and kept sessions you had opened. Like OpenCode itself, it now reconnects after 45 seconds without even a keepalive and reloads the list.
