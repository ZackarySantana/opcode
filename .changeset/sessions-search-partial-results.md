---
"@lidtop/opencode-sessions": patch
---
Improve search. Expensive expressions return the matches found before the time budget, marked partial, instead of failing. Searches no longer wait behind index writes and reuse one regex worker. Titles, directories, and messages are matched separately so anchors such as `^/home` work, Unicode mode is used when the expression allows it, and the 256-character limit counts characters. Previews center on the match without splitting graphemes. Enter now opens the selected session while results refresh in the background.
