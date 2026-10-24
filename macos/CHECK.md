# Semantero: hands-on checks

These are the things only a person at the screen can confirm. The keyboard plumbing (typing, arrows, ↵ / ⌘↵ / ⌘⇧↵,
⌘K, Esc, ⌘L, ⌘1/⌘2) is already checked automatically by `make app-selftest`. Note anything that fails, with what you
saw, in `docs/DECISIONS_AND_GAPS.md` (or just tell Claude).

## 0. Set up (once, about 5 minutes)

1. Optional but recommended: Xcode → Settings → Accounts → add your Apple ID. That creates a free "Personal Team"
   signing certificate, so macOS remembers the permissions below across rebuilds. Without it, every rebuild asks again.
2. `make install-app`, then open **Semantero** from /Applications once. A magnifying glass appears in the menu bar.
3. macOS asks: *"Semantero would like to access files in your Documents folder"* → **Allow**. (If you missed it:
   System Settings → Privacy & Security → Files and Folders → Semantero → Documents.)
4. Menu bar icon → the status line should read about "171 papers, 145 notes".

## 1. The panel (2 minutes)

| # | Do | Expect |
|---|---|---|
| 1.1 | In Mail, Safari and Finder in turn, press **⌥Space** | The panel appears at once, centred near the top, the search field has the cursor. The app you were in stays frontmost (its menu bar stays) |
| 1.2 | Press ⌥Space again, or Esc, or click outside | The panel closes |
| 1.3 | Put an app in full screen (green button), press ⌥Space | The panel shows over it |
| 1.4 | With a second display: put the mouse on it, press ⌥Space | The panel opens on that display |
| 1.5 | Look at it in light and dark mode (System Settings → Appearance) | Glass background, readable text, icons on each row, green dot bottom right |
| 1.6 | Turn on System Settings → Accessibility → Display → Reduce transparency | Still readable (opaque background) |
| 1.7 | If ⌥Space does something else instead (e.g. Claude's quick entry): Settings… → Hotkey → `⌃⌥Space` → Save | The new hotkey works immediately, without restarting |

## 2. Opening things (3 minutes)

| # | Do | Expect |
|---|---|---|
| 2.1 | Type `stress relaxation`, ↵ on the top paper | Zotero opens that PDF at the page shown on the right of the row |
| 2.2 | Find a paper whose row says `snapshot`, ↵ | Zotero opens the web snapshot |
| 2.3 | Type a phrase from one of your notes (e.g. `organoid bottlenecks`), ↵ on the note | Obsidian opens the note. **Note whether it jumps to the heading** shown under the title, or only opens the note |
| 2.4 | ⌘2, type `roth`, then ⌘⇧Z | Zotero selects the item in your library |
| 2.5 | On a paper row, ⌘O | Its literature note opens, or (none yet) Obsidian creates `<citekey>.md`. **Note whether your Zotero template was applied** (probably not) |
| 2.6 | Clear the field | The 10 most recently edited notes show, newest first |

## 3. Getting the file into another app (the main point, 5 minutes)

| # | Do | Expect |
|---|---|---|
| 3.1 | In Mail, start a new message, click in the body, ⌥Space, find a paper, **⌘↵** | The first time: a toast says "Copied, press ⌘V…" with **Open Settings**. Click it, allow Semantero under Accessibility |
| 3.2 | Repeat 3.1 | The PDF is attached to the message (no extra keypress) |
| 3.3 | Same in a Teams chat, in the Claude desktop app, and in claude.ai / ChatGPT in a browser | The PDF is attached / uploaded |
| 3.3b | Outlook on the web: if the attachment shows "Something went wrong while the document preview was being created", (a) wait a minute and click it again, (b) Download it and open it, (c) attach the **same** PDF with Outlook's own Attach button | (b) opens the full PDF. If (c) gives the same preview error, it's Outlook's preview of that PDF, not the app (the app's paste was verified to hand Firefox the exact file) |
| 3.4 | Same in Terminal | The path is pasted (that's what Terminal does with a file) |
| 3.5 | In a text field anywhere, ⌥Space, **⌘⇧↵** on a result | The passage is pasted with its citation, e.g. `"…" (Roth et al., 2023, p. 6)` |
| 3.6 | ⌘⌥C, then ⌘V somewhere; ⌘L in a text field | The passage with citation; `[[citekey]]` (or `[[Note name]]`) pasted straight in |
| 3.7 | ⌘⇧C on a result, then ⌘V in a Finder window or a Mail message | The file is copied |
| 3.8 | Drag a row into a Mail message, onto the Desktop, into a browser upload box | The file goes there |
| 3.9 | ⌘⇧F on a result | Finder opens with the file selected |
| 3.10 | ⌘Y on a result | Quick Look shows it; the search panel stays open behind it |
| 3.11 | Click in a password field (e.g. a login page), ⌥Space, ⌘⇧↵ | A toast says "Copied, paste manually." Nothing is typed into the password field |
| 3.12 | ⌘K on a result | A solid card appears bottom right over a dimmed panel, naming the result, with every action, icon and shortcut readable; nothing shows through |
| 3.13 | In it, ↓↓, then type `fin`, ↵; also try clicking an action, and Esc | Arrows move the highlight, typing filters to "Show in Finder", ↵ runs it; a click runs; Esc closes the menu and keeps the panel |

## 4. Staying up to date (10 minutes, mostly waiting)

| # | Do | Expect |
|---|---|---|
| 4.1 | Add a new sentence with an unusual word to today's daily note, save, wait up to 5 minutes | Searching that word finds the note (no action in the app) |
| 4.2 | Add a paper to Zotero (with PDF), wait ~2 minutes | It is findable by its title |
| 4.3 | `brew services stop ollama`, search a long phrase | Keyword results only; grey dot "semantic off: Ollama not reachable". No error pop-ups |
| 4.4 | `brew services start ollama`, search again | Green dot; results improve after a short pause |
| 4.5 | Add a note to `[notes].exclude` in `config.local.toml`, run `.venv/bin/python -m planner notes index` | That note is gone from the panel and from ⌘Space, even by exact title |

## 5. Spotlight (3 minutes)

| # | Do | Expect |
|---|---|---|
| 5.1 | ⌘Space, type a citekey (e.g. `roth2023tunable`) or a note's title | The item appears (from Semantero); Return opens it in Zotero / Obsidian |
| 5.2 | ⌘Space, type `Search Everything`, press **Tab**, type a query | Results from your library update as you type; choosing one opens it. **Note exactly what happens**: live results, only suggestions, or nothing |
| 5.3 | Quit Semantero (menu bar → Quit), then try 5.2 | Probably needs the app running; note what you see |
| 5.4 | Settings… → untick "Add note titles" → Save; ⌘Space a note title | Notes no longer appear from Semantero (macOS's own file results still do) |

## 6. Settings and startup (3 minutes)

| # | Do | Expect |
|---|---|---|
| 6.1 | Menu bar → Settings… | The window opens in front |
| 6.2 | Change Results to 5, Save, search | 5 rows, immediately |
| 6.3 | Log out and back in, then press ⌥Space at once | The app is running and results appear (launch at login) |
| 6.4 | After an hour of normal use: Activity Monitor → Memory → Semantero | Under ~400 MB (it compacts itself back to ~110–160 MB when it grows past 350 MB while hidden) |
| 6.5 | VoiceOver on (⌘F5), open the panel, arrow through rows | Each row is read as "Paper/Note, title, …" |

## What to report back

For each failure: the step number, the app you were in, what you expected and what happened. For 2.3, 2.5, 5.2 and
5.3, report what happens even if it "works", since the spec has a decision waiting on each.
