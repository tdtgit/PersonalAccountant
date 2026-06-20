import { describe, expect, it } from "bun:test";
import { buildMessageWithReplyContext, formatTransactionDetails, normalize, stripTelegramMarkdown } from "./index";

describe("normalize", () => {
  it("escapes Telegram MarkdownV2 characters and removes source markers", () => {
    const input = "Amount [100]_! from #shop.【12:3†source】";
    const output = normalize(input);

    expect(output).toBe("Amount \\[100\\]\\_\\! from \\#shop\\.");
  });

  it("escapes Telegram MarkdownV2 parentheses", () => {
    expect(normalize("Paid (AUD)")).toBe("Paid \\(AUD\\)");
  });

  it("preserves single-asterisk Telegram MarkdownV2 bold markers", () => {
    expect(normalize("*Tổng cộng:* 100 AUD")).toBe("*Tổng cộng:* 100 AUD");
  });

  it("strips Telegram Markdown markers for the plain-text fallback", () => {
    expect(stripTelegramMarkdown("*Tổng cộng:* 100 AUD (ước tính).【12:3†source】")).toBe(
      "Tổng cộng: 100 AUD ước tính"
    );
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
