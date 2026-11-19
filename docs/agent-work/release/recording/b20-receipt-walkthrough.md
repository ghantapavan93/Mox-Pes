# B20 receipt walkthrough

`b20-receipt-walkthrough.webm`: 55.6 s, 1920 × 1200 VP8, no audio (captions carry it). Recorded on
https://revenue-signal-os-green.vercel.app as the public-demo guest, with production serving
`8bbf37c`, by `../harness/record-b20-receipt.cjs`. It replaces `b20-walkthrough.webm`, which
opened on the Overview.

| Time | Page | Caption |
|---|---|---|
| 0:00 | Incident #1063, the receipt | B20's October paid CAC was reported at $490.11. An approved, verified repair corrected it to $271.31. |
| 0:07.5 | the receipt: the arithmetic, why it moved | Same $15,193.47 of paid spend. While 119 call records were held, 25 paid customers had no paid touch on record: 31 before, 56 after. |
| 0:15.5 | Evidence | The evidence: 119 call records failed validation (MISSING_FIELD) and were held instead of guessed. |
| 0:21.3 | Records that were held | Replayed through calls@1.1, each held call attached to the customer it produced, with its paid source. |
| 0:27.7 | the receipt: what did not change | Unchanged: the same $15,193.47 of paid spend and the same 109 serviced customers. Only attribution moved. |
| 0:35.6 | AI Investigator | Ask the investigator the same question. |
| 0:39.1 | its answer | It answers from the stored receipt for what happened and from today's scorecard for now, and cites both. |
| 0:45.1 | its next step | Its next step: a verified repair is not permission to move budget. |
| 0:49.6 | Decision Lab, B20, Oct 1–30 | Correction verified. Budget move not approved. |

Frames are captured only once a page is ready, so the video has no loading wait, and no homepage
tour. The caption sits over the content column, so the sidebar's "all data synthetic" notice
stays in view. The visitor's question was deleted after the recording; its investigation id
was never on screen.

**Reviewed** by decoding the exported file end to end (57 one-per-second frames, no decode
error) and reading a frame of every scene at full size: the October $490.11 → $271.31 is on the
first frame; $15,193.47, 31, 56, 119 and 109 and every caption are legible.
