# Review: books/build-with-ai/how-to/notification-sound.md

- Content type: docs
- Original verdict: REVISE
- Final verdict: ACCEPT
- Em-dash occurrences found: 0
- Broken citekeys: []

## Original scores
Correctness: 3, Clarity & structure: 5, Completeness: 4, House style: 3

## Re-review scores
Correctness: 4, Clarity & structure: 5, Completeness: 4, House style: 5

## Findings
- [resolved] Correctness (was major): The `Notification` hook row now reads "Only fires on attention-requiring events (permission, auth, or idle prompts), so it won't fire when Claude simply finishes a normal response." This matches the Claude Code hooks reference and corrects the prior inaccurate "fires only when terminal not focused" rationale. The `Stop` hook description (it fires every time Claude finishes responding regardless of focus) is accurate.
- [resolved] House style (was minor): All six em-dash characters are gone. The four "What It Does" bullets use colons, and the two table cells were rephrased (one corrected sentence, one using "so"). Verified zero em-dash and en-dash characters in the file; the remaining "---" lines are markdown horizontal rules and the "|----------|" line is a table separator, not prose dashes.
- [minor] Correctness: Line 72, "Shows a "Show" button that opens Script Editor" for `osascript display notification` is still stated as a flat fact. This is environment-dependent (button label and owning app vary by macOS version). Optional: qualify with "can show" or note the macOS version observed. Not blocking.
- [minor] Completeness: settings.json also supports project scope (.claude/settings.json) and local scope (.claude/settings.local.json) in addition to ~/.claude/settings.json. A one-line note that the same Stop hook can live at project scope would round out the guide. The user-level instruction as written is correct. Not blocking.

## Decision rationale
The single major correctness defect from the prior round is fixed and the house-style violation is fully cleared. The two remaining items are minor, optional, and non-blocking. The guide is correct, well structured, and complete enough to ship.

## Remaining issues after repair
- [minor] osascript "Show" button claim stated without environment qualifier (optional).
- [minor] No mention of project/local settings.json scope (optional completeness add).
