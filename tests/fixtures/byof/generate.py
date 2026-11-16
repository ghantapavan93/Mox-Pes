"""
Bring-your-own-file fixture: a synthetic Microsoft Advertising-style daily campaign report that
the importer has never seen, and the expectations for it, computed here and frozen before any
upload (docs/agent-work/BYOF-WORKFLOW.md).

Independent of the importer on purpose: plain Python and Decimal arithmetic, no product code. It
writes three files beside itself:
  microsoft-ads-daily.csv            the valid export: one US-dollar account, 3 campaigns x 14 days
  microsoft-ads-daily-two-accounts.csv
                                     the same report with a second account in Canadian dollars:
                                     a meaningful data problem, since its cost is not US dollars
  expected.json                      row counts, date scope, branch scope and exact totals

The shape follows what such a report carries: report-title lines above the header, US month-first
dates, a "Currency code" column, a "Total" row and a copyright line at the end. It is synthetic:
the account, the campaigns and every number are made up.

  python -I tests/fixtures/byof/generate.py
"""
import csv
import hashlib
import io
import json
import pathlib
from datetime import date, timedelta
from decimal import Decimal

HERE = pathlib.Path(__file__).resolve().parent
FIRST, DAYS = date(2026, 10, 12), 14
ACCOUNTS = {
    "usd": {"name": "Lakeside Pest Co", "number": "B0123456", "currency": "USD"},
    "cad": {"name": "Lakeside Pest Co (Canada)", "number": "B0123457", "currency": "CAD"},
}
CAMPAIGNS = [
    {"name": "Termite Inspections - Search", "id": "812340001", "base": Decimal("74.00"), "account": "usd"},
    {"name": "Mosquito Season - Search", "id": "812340002", "base": Decimal("52.00"), "account": "usd"},
    {"name": "Rodent Control - Audience", "id": "812340003", "base": Decimal("38.00"), "account": "usd"},
]
HEADER = ["Account name", "Account number", "Campaign name", "Campaign ID", "Gregorian date", "Currency code", "Impressions", "Clicks", "Spend", "Conversions"]


def unit(*parts: object) -> int:
    """A deterministic number from 0 to 9999 for a (campaign, day, purpose): no random state."""
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:8], 16) % 10_000


def rows(campaigns: list[dict]) -> list[dict]:
    out = []
    for c in campaigns:
        for d in range(DAYS):
            day = FIRST + timedelta(days=d)
            # base - $20.00 + $0.00 to $99.99: at least $18.00, never zero or negative.
            spend = (c["base"] + Decimal(unit(c["id"], day, "spend")) / 100 - Decimal("20.00")).quantize(Decimal("0.01"))
            clicks = 8 + unit(c["id"], day, "clicks") % 40
            out.append({
                "account": ACCOUNTS[c["account"]],
                "campaign": c,
                "day": day,
                "impressions": 300 + unit(c["id"], day, "impressions") % 2_400,
                "clicks": clicks,
                "spend": spend,
                "conversions": unit(c["id"], day, "conversions") % 6,
            })
    return out


def thousands(n: int) -> str:
    return f"{n:,}"


def report(data: list[dict]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
    last = FIRST + timedelta(days=DAYS - 1)
    us = lambda d: f"{d.month}/{d.day}/{d.year}"
    for line in [
        "Report Name: Campaign Performance - Daily",
        f"Report Time: {us(FIRST)} - {us(last)}",
        "Time Zone: (GMT-06:00) Central Time (US & Canada)",
        f"Last Completed Available Day: {us(last + timedelta(days=1))} 6:00:00 AM (GMT-06:00) Central Time (US & Canada)",
        "Report Aggregation: Daily",
        "Report Filter: ",
        "Potential Incomplete Data: false",
        f"Rows: {len(data)}",
    ]:
        w.writerow([line])
    buf.write("\r\n")
    w.writerow(HEADER)
    for r in data:
        w.writerow([r["account"]["name"], r["account"]["number"], r["campaign"]["name"], r["campaign"]["id"], us(r["day"]), r["account"]["currency"],
                    thousands(r["impressions"]), str(r["clicks"]), f"{r['spend']:.2f}", str(r["conversions"])])
    w.writerow(["Total", "", "", "", "", "", thousands(sum(r["impressions"] for r in data)), str(sum(r["clicks"] for r in data)),
                f"{sum(r['spend'] for r in data):.2f}", str(sum(r["conversions"] for r in data))])
    buf.write("\r\n")
    w.writerow(["©2026 Microsoft Corporation. All rights reserved. "])
    return buf.getvalue().encode("utf-8")


def cents(amount: Decimal) -> int:
    return int((amount * 100).to_integral_value())


def summary(data: list[dict]) -> dict:
    return {
        "rows": len(data),
        "spendCents": cents(sum((r["spend"] for r in data), Decimal("0"))),
        "spend": f"{sum((r['spend'] for r in data), Decimal('0')):.2f}",
        "clicks": sum(r["clicks"] for r in data),
        "conversions": sum(r["conversions"] for r in data),
        "campaigns": sorted({r["campaign"]["id"] for r in data}),
        "accounts": sorted({r["account"]["number"] for r in data}),
        "currencies": sorted({r["account"]["currency"] for r in data}),
        "firstDay": min(r["day"] for r in data).isoformat(),
        "lastDay": max(r["day"] for r in data).isoformat(),
        "byCampaign": {c: {"rows": len(x), "spendCents": cents(sum((r["spend"] for r in x), Decimal("0")))} for c in sorted({r["campaign"]["id"] for r in data}) for x in [[r for r in data if r["campaign"]["id"] == c]]},
    }


def main() -> None:
    valid = rows(CAMPAIGNS)
    two = rows([CAMPAIGNS[0], CAMPAIGNS[1], {**CAMPAIGNS[2], "account": "cad"}])
    files = {"microsoft-ads-daily.csv": report(valid), "microsoft-ads-daily-two-accounts.csv": report(two)}
    for name, data in files.items():
        (HERE / name).write_bytes(data)
    usd = [r for r in two if r["account"]["currency"] == "USD"]
    cad = [r for r in two if r["account"]["currency"] == "CAD"]
    expected = {
        "frozen": "Computed by tests/fixtures/byof/generate.py before any upload of these files. Not derived from the importer.",
        "source": "Microsoft Advertising-style daily campaign report (synthetic); platform microsoft_ads",
        "workspace": "empty: migrations only, no seed, no ledger records, no campaign mappings, no currency rules",
        "files": {
            "valid": {
                "file": "microsoft-ads-daily.csv",
                "sha256": hashlib.sha256(files["microsoft-ads-daily.csv"]).hexdigest(),
                "dataRows": len(valid),
                "nonDataLines": {"titleLinesAboveHeader": 8, "totalRow": 1, "copyrightLine": 1},
                "expect": {
                    "validRows": len(valid),
                    "refusedRows": 0,
                    **summary(valid),
                    "dateScope": f"{FIRST.isoformat()} to {(FIRST + timedelta(days=DAYS - 1)).isoformat()}, {DAYS} days",
                    "branchScope": "none: the report has no branch column and an empty workspace maps no campaign to a branch, so no spend may be attributed to a branch",
                    "ledger": "nothing added: ad spend from a file is compare-only, and the empty ledger holds none of these campaign-days",
                },
            },
            "twoAccounts": {
                "file": "microsoft-ads-daily-two-accounts.csv",
                "sha256": hashlib.sha256(files["microsoft-ads-daily-two-accounts.csv"]).hexdigest(),
                "dataRows": len(two),
                "problem": f"campaign {CAMPAIGNS[2]['id']} belongs to a second account that reports in Canadian dollars",
                "expect": {
                    "usDollarRows": summary(usd),
                    "canadianDollarRows": {**summary(cad), "note": "spendCents here are Canadian cents, not US cents"},
                    "rule": "the Canadian-dollar rows are refused or left unverified, never summed as US dollars; the US-dollar total covers the US-dollar rows only",
                },
            },
        },
        "duplicateUpload": {
            "file": "microsoft-ads-daily.csv",
            "expect": "the same result as the first upload of the valid file; the ledger is unchanged; nothing is counted twice",
        },
        "mustNotClaim": ["leads", "customers", "cost per customer (CAC)", "ROI", "a budget recommendation"],
    }
    (HERE / "expected.json").write_text(json.dumps(expected, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v.get("sha256") for k, v in expected["files"].items()}, indent=1))
    print(f"valid: {len(valid)} rows, ${summary(valid)['spend']}; two accounts: USD {len(usd)} rows ${summary(usd)['spend']}, CAD {len(cad)} rows {summary(cad)['spend']} CAD")


if __name__ == "__main__":
    main()
