import { describe, it, expect } from "vitest";
import { DnsFilter } from "../../src/security/dns-filter.js";

describe("DnsFilter", () => {
  it("blocks listed domains", () => {
    const filter = new DnsFilter();
    expect(filter.isBlocked("evil.com")).toBe(true);
  });

  it("allows unlisted domains", () => {
    const filter = new DnsFilter();
    expect(filter.isBlocked("api.anthropic.com")).toBe(false);
  });

  it("addBlock adds domain", () => {
    const filter = new DnsFilter();
    filter.addBlock("bad-domain.io");
    expect(filter.isBlocked("bad-domain.io")).toBe(true);
  });
});
