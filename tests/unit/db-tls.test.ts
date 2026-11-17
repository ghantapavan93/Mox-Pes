import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { tlsOption } from "@/lib/db";

/** The TLS the driver will actually use for a URL, after it merges the URL with our option. */
function effectiveSsl(connectionString: string): unknown {
  const client = new Client({ connectionString, ...tlsOption(connectionString) });
  return (client as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
}

describe("tlsOption: hosted databases are reached over TLS", () => {
  it("leaves local databases and Unix sockets plain", () => {
    for (const url of [
      "postgres://postgres@127.0.0.1:54333/revenue_signal",
      "postgres://postgres@localhost/revenue_signal",
      "postgres://postgres@[::1]:5432/revenue_signal",
      "postgres:///revenue_signal?host=/var/run/postgresql",
    ]) {
      expect(tlsOption(url), url).toEqual({});
      expect(effectiveSsl(url), url).toBe(false);
    }
  });

  it("verifies the certificate of a hosted database whose URL names no sslmode (Render's copied URL)", () => {
    const url = "postgresql://user:secret@dpg-example-a.virginia-postgres.render.com/revenue_signal";
    expect(tlsOption(url)).toEqual({ ssl: { rejectUnauthorized: true } });
    expect(effectiveSsl(url)).toEqual({ rejectUnauthorized: true });
  });

  it("lets an sslmode in the URL decide", () => {
    const base = "postgresql://user:secret@db.example.com/revenue_signal";
    expect(effectiveSsl(`${base}?sslmode=disable`)).toBe(false);
    expect(effectiveSsl(`${base}?sslmode=no-verify`)).toEqual({ rejectUnauthorized: false });
    expect(effectiveSsl(`${base}?sslmode=verify-full`)).toEqual({});
  });

  it("adds nothing to a string that is not a URL", () => {
    expect(tlsOption("not a url")).toEqual({});
  });
});
