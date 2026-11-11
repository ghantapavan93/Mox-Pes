import { describe, expect, it } from "vitest";
import { parseRecordId } from "../../lib/record-id";

describe("parseRecordId (one rule for a database id taken from a URL)", () => {
  it("accepts a plain positive integer of up to 15 digits", () => {
    expect(parseRecordId("2455")).toBe(2455);
    expect(parseRecordId("999999999999999")).toBe(999_999_999_999_999);
  });

  it("refuses ids Postgres bigint or a JS number cannot hold exactly (the incident page crashed on these)", () => {
    expect(parseRecordId("99999999999999999999")).toBeNull();
    expect(parseRecordId("9007199254740993")).toBeNull();
  });

  it("refuses everything that is not canonical decimal digits", () => {
    for (const raw of ["", "0", "-1", "1.5", "1e3", " 12", "12 ", "0x1f", "NaN", "Infinity", "１２", "12abc", "toString"]) {
      expect(parseRecordId(raw), raw).toBeNull();
    }
  });
});
