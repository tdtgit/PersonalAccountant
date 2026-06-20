import { describe, expect, it } from "bun:test";
import { buildMessageWithReplyContext, formatTransactionDetails, normalize } from "./index";

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


describe("buildMessageWithReplyContext", () => {
  it("uses the current Telegram text when there is no reply", () => {
    expect(buildMessageWithReplyContext({ text: "Tháng này tốn bao nhiêu?" })).toBe(
      "Tháng này tốn bao nhiêu?"
    );
  });

  it("includes the replied Telegram message as context", () => {
    const result = buildMessageWithReplyContext({
      text: "Cái này là gì?",
      reply_to_message: { text: "Bạn đã tiêu 120.000 VNĐ ở Highlands." },
    });

    expect(result).toContain("Previous Telegram message:\nBạn đã tiêu 120.000 VNĐ ở Highlands.");
    expect(result).toContain("Current user message:\nCái này là gì?");
  });
});
