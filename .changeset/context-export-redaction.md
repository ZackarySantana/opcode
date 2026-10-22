---
"@lidtop/opencode-context": patch
---
Export redaction now catches prefixed secret names (`OPENAI_API_KEY=`, `GITHUB_TOKEN=`, `client_secret=`), credentials in non-HTTP URLs (`postgres://`, `mongodb+srv://`), `gsk_`/`hf_`/`AIza` keys, `key=` query parameters, and no longer leaves a stray `]` after `Authorization: Bearer` values.
