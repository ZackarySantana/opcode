# @lidtop/opencode-media

## 0.1.2

### Patch Changes

- 5ccffe8: Shared code moved into helpers every plugin bundles: the refresh schedule now also works outside the terminal, and there are new helpers for state shared by a server's projects, RPC contracts and handlers, and following a server's state. For Context, Feed, Later, and Media nothing changes. In Cost, Review, Snippets, and Sessions, a call the terminal aborted is no longer reported as a failure. In Sessions, every project open on a server now shares one search index connection and one writer per database file, rather than possibly one per project.
- e91635a: Shared code that Feed and GH PR Status use moved into helpers every plugin bundles: the minute clock that ages views, and sending changes to the server in order while showing them at once. Nothing changes for any plugin.

## 0.1.1

### Patch Changes

- 39be630: When a model returns fewer images than requested, they keep the numbered names you approved instead of asking again. An image path whose extension already matches the returned format is kept as written, so `photo.jpeg` stays `photo.jpeg`. A missing reference image is reported before anything is asked or spent, and an empty speech response is an error instead of an empty file. The docs note that MiniMax speech models only make `.mp3`.

## 0.1.0

### Minor Changes

- c851a08: Add Media: agent tools that generate speech, sound effects, and images with the OpenRouter key saved by `/connect`, save them into the project, and report the key's remaining credit. Generations follow your permission rules, and the key keeps working when a policy denies the OpenRouter provider.
