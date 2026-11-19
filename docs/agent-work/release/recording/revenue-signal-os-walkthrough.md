# Revenue Signal OS walkthrough (for the VPs)

`revenue-signal-os-walkthrough.mp4`: 1 min 58.7 s, 1920 × 1200, H.264 (yuv420p, limited range),
no audio (captions carry it), 12.6 MB. Recorded on https://revenue-signal-os-green.vercel.app as the
public-demo guest, with production serving `e10042f` and the hosted copy's worked examples in place
(`npm run db:examples-hosted`), by `../harness/record-vp-walkthrough.cjs`. It plays on the Start
page (`public/media/`, the same file) and is the one to attach.

The story follows what the two VP readers judge (docs/agent-work/MASTER-MISSION.md §1): for the
product side, a decision stopped when the data disagrees, a root cause, a verified repair and its
measured effect; for the data side, one source of truth, changes made safely and checked before they
land, and tests. It ends on the reviewer's own file moving the reviewer's own dashboard.

| Time | Page | Caption |
|---|---|---|
| 0:00 | Opening card | Built before the interview: a working prototype of what I would build for your marketing and data teams. |
| 0:06 | Start here | When the systems disagree, it holds the decision, shows the evidence, and sends the fix through a test run and a separate approval. |
| 0:12 | Overview | Ad platforms claimed 7,776 conversions in October. 4,753 paid prospects reached the business, and 1,386 are serviced customers so far. |
| 0:20 | Overview, issues for review | Where the records disagree, it stops the line: two branches' budget decisions are on hold. |
| 0:26 | Decision Lab, B09 | B09 is held until the incident behind it is resolved: no channel comparison is a safe basis for moving budget yet. |
| 0:32 | Incident #1063, the receipt | B20's October cost per paid customer was reported at $490.11. A verified repair corrected it to $271.31. |
| 0:40 | Evidence | The cause: the call feed renamed a field. 119 calls failed validation and were held, not guessed. |
| 0:47 | The receipt: what did not change | Replayed through the corrected mapper: the same $15,193.47 of spend and the same 109 customers. Only the attribution moved. |
| 0:55 | Audit history | One role proposed it, another tested it in a dry run that saved nothing, and a different role approved it. Every step is audited. |
| 1:02 | AI Investigator | Ask why a number moved. / It answers from stored records with read-only tools, and every finding cites the record it rests on. |
| 1:12 | Data onboarding | Now your own data. Upload an export, or this sample: calls a feed never delivered for B01's customers. |
| 1:17 | The upload's result | Every row is checked with the rules the live feed uses. Then count it in a private copy. |
| 1:23 | Your dashboard | Your dashboard moves with your file: B01's cost per paid customer, $392.50 to $322.73. Nobody else's numbers change. |
| 1:31 | Your dashboard, the tiles | Counted through the real intake and reconciliation, in a transaction that is rolled back. Spend did not change; attribution did. |
| 1:37 | ChangeGuard | Configuration changes are run through the production write path in a rolled-back transaction, then approved by someone else. |
| 1:44 | Start here, how it is built | Next.js and Postgres. Every source lands once per version, every metric is defined once in SQL, and over a thousand tests run before each release. |
| 1:51 | Closing card | Rather than only describe how I would contribute, I built it first. Try it: revenue-signal-os-green.vercel.app/start. |

Frames are captured only once a page is ready, so no loading wait is in the video. The caption sits
over the content column, so the sidebar's "all data synthetic" notice stays in view. The visitor's
question and upload were deleted after the recording.

**Reviewed** by decoding the exported file end to end (no decode error) and reading a frame of every
scene at 1280 px: each figure above is on screen as captioned, and every caption is legible. The
recorder wrote full-range frames (`yuvj420p`); the file was converted to limited-range yuv420p
(`scale=in_range=pc:out_range=tv,format=yuv420p`, CRF 19), and the recorder now converts as it
encodes.
