import { expect, test } from "bun:test";
import {
  getYoutubeCommandAccessProblem,
  isSamePrivatePhoneJid,
  isYoutubeSenderAllowed,
  isYoutubeUrl,
  parseYoutubeCommand,
  renderYoutubeFormatMenu,
} from "@/services/youtubeDownloader";

test("a URL command requests the exact-size format menu", () => {
  expect(parseYoutubeCommand("!yt https://youtu.be/abc123")).toEqual({
    kind: "list-formats",
    url: "https://youtu.be/abc123",
    valid: true,
  });
  expect(parseYoutubeCommand("/youtube https://www.youtube.com/watch?v=abc123").kind).toBe(
    "list-formats",
  );
});

test("parses two numbered track choices, including zero as one skipped track", () => {
  expect(parseYoutubeCommand("!yt 3 5")).toEqual({
    kind: "select-formats",
    videoIndex: 3,
    audioIndex: 5,
  });
  expect(parseYoutubeCommand("!yt 0 5")).toEqual({
    kind: "select-formats",
    videoIndex: 0,
    audioIndex: 5,
  });
  expect(parseYoutubeCommand("!yt 3 0")).toEqual({
    kind: "select-formats",
    videoIndex: 3,
    audioIndex: 0,
  });
  expect(parseYoutubeCommand("!yt 0 0")).toEqual({
    kind: "select-formats",
    videoIndex: 0,
    audioIndex: 0,
  });
  expect(parseYoutubeCommand("!yt 3").kind).toBe("invalid");
});

test("accepts only secure single-video YouTube URLs", () => {
  expect(isYoutubeUrl("https://music.youtube.com/watch?v=abc123")).toBe(true);
  expect(isYoutubeUrl("https://youtu.be/abc123?si=share-token")).toBe(true);
  expect(isYoutubeUrl("http://youtu.be/abc123")).toBe(false);
  expect(isYoutubeUrl("https://youtube.com.example.net/watch?v=abc123")).toBe(false);
  expect(isYoutubeUrl("https://www.youtube.com/playlist?list=PL123")).toBe(false);
  expect(isYoutubeUrl("https://www.youtube.com/watch?v=abc123&list=PL123")).toBe(false);
  expect(isYoutubeUrl("https://youtu.be/")).toBe(false);
  expect(parseYoutubeCommand("!yt https://example.com/video")).toEqual({
    kind: "list-formats",
    url: "https://example.com/video",
    valid: false,
  });
});

test("help and ordinary messages are distinguished from download commands", () => {
  expect(parseYoutubeCommand("!yt help")).toEqual({ kind: "help" });
  expect(parseYoutubeCommand("Hello there")).toEqual({ kind: "not-command" });
});

test("format menu displays exact byte counts and never advertises approximate sizes", () => {
  const text = renderYoutubeFormatMenu({
    url: "https://youtu.be/abc123",
    title: "Sample",
    video: [{ formatId: "137", label: "1080p · mp4 · avc1", exactSizeBytes: 53_687_091 }],
    audio: [{ formatId: "140", label: "m4a · mp4a · 128 kbps", exactSizeBytes: 4_194_304 }],
  });
  expect(text).toContain("53,687,091 بايت");
  expect(text).toContain("4,194,304 بايت");
  expect(text).toContain("!yt 3 5");
  expect(text).toContain("0 لأحد الرقمين");
  expect(text).toContain("لم تُستخدم الأحجام التقريبية");
});

test("only allowlisted private phone JIDs pass sender authorization", () => {
  expect(isYoutubeSenderAllowed("15551234567@s.whatsapp.net", "15551234567,447700900123")).toBe(
    true,
  );
  expect(isYoutubeSenderAllowed("15551234567:4@s.whatsapp.net", "15551234567")).toBe(true);
  expect(isYoutubeSenderAllowed("15551234568@s.whatsapp.net", "15551234567")).toBe(false);
  expect(isYoutubeSenderAllowed("15551234567@g.us", "15551234567")).toBe(false);
  expect(isYoutubeSenderAllowed("15551234567@newsletter", "15551234567")).toBe(false);
  expect(isYoutubeSenderAllowed("status@broadcast", "15551234567")).toBe(false);
});

test("reports missing downloader configuration rather than silently authorizing", () => {
  expect(
    getYoutubeCommandAccessProblem(undefined, "15551234567", "15551234567@s.whatsapp.net"),
  ).toBe("disabled");
  expect(getYoutubeCommandAccessProblem("true", "", "15551234567@s.whatsapp.net")).toBe(
    "allowlist-empty",
  );
  expect(
    getYoutubeCommandAccessProblem(" TRUE ", "15551234567", "15551234568@s.whatsapp.net"),
  ).toBe("sender-not-allowed");
  expect(getYoutubeCommandAccessProblem("true", "15551234567", "15551234567@s.whatsapp.net")).toBe(
    null,
  );
});

test("matches self-chat only when both JIDs are the same private phone number", () => {
  expect(isSamePrivatePhoneJid("15551234567@s.whatsapp.net", "15551234567:4@s.whatsapp.net")).toBe(
    true,
  );
  expect(isSamePrivatePhoneJid("15551234567@g.us", "15551234567@s.whatsapp.net")).toBe(false);
  expect(isSamePrivatePhoneJid("15551234567@s.whatsapp.net", "15551234568@s.whatsapp.net")).toBe(
    false,
  );
});
