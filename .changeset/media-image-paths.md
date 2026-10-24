---
"@lidtop/opencode-media": patch
---

When a model returns fewer images than requested, they keep the numbered names you approved instead of asking again. An image path whose extension already matches the returned format is kept as written, so `photo.jpeg` stays `photo.jpeg`. A missing reference image is reported before anything is asked or spent, and an empty speech response is an error instead of an empty file. The docs note that MiniMax speech models only make `.mp3`.
