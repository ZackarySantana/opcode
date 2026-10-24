---
"@lidtop/opencode-snippets": patch
---

Snippet files saved with a byte order mark, or with `aliases:` items written as unindented `- item` lines, keep their description and aliases. `snippet_delete` reports a missing snippet, an alias, or the wrong scope before asking for approval, and `snippet_write` rejects aliases that would insert another snippet (a name always wins over an alias) before asking, naming the snippet each one inserts. A project snippet's alias may still take over a global snippet's alias. An alias two snippets of the same scope share now goes to the first by name.
