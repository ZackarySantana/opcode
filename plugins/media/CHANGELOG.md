# @lidtop/opencode-media

## 0.1.1

### Patch Changes

- 39be630: When a model returns fewer images than requested, they keep the numbered names you approved instead of asking again. An image path whose extension already matches the returned format is kept as written, so `photo.jpeg` stays `photo.jpeg`. A missing reference image is reported before anything is asked or spent, and an empty speech response is an error instead of an empty file. The docs note that MiniMax speech models only make `.mp3`.

## 0.1.0

### Minor Changes

- c851a08: Add Media: agent tools that generate speech, sound effects, and images with the OpenRouter key saved by `/connect`, save them into the project, and report the key's remaining credit. Generations follow your permission rules, and the key keeps working when a policy denies the OpenRouter provider.
