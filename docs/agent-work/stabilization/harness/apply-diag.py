"""Add the stabilization diagnostics hook to the two specs in the verification worktree.

    python -I C:/Temp/stab/apply-diag.py C:/Temp/rso-rc

Only active when STAB_DIAG (the init script) and STAB_DIAG_LOG (the log file) are set.
Restore with: git -C C:/Temp/rso-rc checkout -- tests/e2e/golden-path.spec.ts tests/e2e/zzzzzz-drift-review.spec.ts
"""
import sys

root = sys.argv[1]
HOOK = '''
// STABILIZATION DIAGNOSTICS (C:/Temp/stab, never committed): focus, rAF, fetch and click timing.
if (process.env.STAB_DIAG) {
  test.beforeEach(async ({ page }, testInfo) => {
    const fs = await import("node:fs");
    await page.addInitScript({ content: fs.readFileSync(process.env.STAB_DIAG!, "utf8") });
    page.on("console", (m) => {
      if (m.text().startsWith("[diag]")) fs.appendFileSync(process.env.STAB_DIAG_LOG!, `${testInfo.titlePath.slice(1).join(" > ")} | ${m.text()}\\n`);
    });
  });
}
'''
for rel, anchor in [
    ("tests/e2e/golden-path.spec.ts", 'import { fixThroughActionCenter, setRole } from "./action-center";\n'),
    ("tests/e2e/zzzzzz-drift-review.spec.ts", 'import { VIEWERS } from "../../lib/viewer";\n'),
]:
    path = f"{root}/{rel}"
    with open(path, encoding="utf-8", newline="") as f:
        text = f.read()
    if "STABILIZATION DIAGNOSTICS" in text:
        print(f"{rel}: already patched")
        continue
    eol = "\r\n" if "\r\n" in text else "\n"
    anchor_eol = anchor.replace("\n", eol)
    assert anchor_eol in text, f"anchor not found in {rel}"
    text = text.replace(anchor_eol, anchor_eol + HOOK.replace("\n", eol), 1)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    print(f"{rel}: patched")
