---
"@lidtop/opencode-snippets": minor
---

Snippets can use other snippets: `@name` on its own in a snippet's body is replaced by that snippet's current text when it is sent, through nested references. A reference to no snippet, a loop, or an expansion past 64 KiB stays as typed, and `/snippets` and the desktop list mark such a snippet **broken reference**. Writing a snippet in chat rejects those references before asking for approval, and deleting one names the snippets that used it.
