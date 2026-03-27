import { describe, expect, it } from "bun:test";
import { formatTransactionDetails, normalize } from "./index";

describe("normalize", () => {
  it("escapes Telegram MarkdownV2 characters and removes source markers", () => {
    const input = "Amount [100]_! from #shop.【12:3†source】";
    const output = normalize(input);

    expect(output).toBe("Amount \\[100\\]\\_\\! from \\#shop\\.");
  });
});

describe("formatTransactionDetails", () => {
  it("returns a transaction error message when error exists", () => {
    expect(formatTransactionDetails({ error: "Invalid payload" })).toBe(
      "Transaction error: Invalid payload"
    );
  });

  it("falls back to N/A when fields are missing", () => {
    const result = formatTransactionDetails({ message: "Paid 100k" });

    expect(result).toContain("Paid 100k");
    expect(result).toContain("*Từ:* N/A");
    expect(result).toContain("*Ngày:* N/A");
  });
});
