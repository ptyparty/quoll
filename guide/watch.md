# Noticing the user's edits

The user often answers open questions and edits plans in the notebook rather than in chat. Keep a watch running while you work in a story so you see those edits without being told:

```bash
quoll watch
```

It prints `changed: <page>` each time a page is saved and runs until stopped. Start it with the Monitor tool, which turns each line into a notification. A background shell command would have to exit to report a change, and in komux every restart shows up as a new job.

Monitor stops a watch after at most 30 minutes; start it again when it does. Your own writes are reported too, so skip pages you have just written. When one of those wakes you after your turn has ended and brings nothing else, end the turn at once; inside komux, with a `**KOMUX: NO TOAST**` line, so the user is not toasted about your own edit. When the user changes a page, read it, act on what they wrote, and fold answers into the page: move a settled question into `decisions.md`, or update the plan.
