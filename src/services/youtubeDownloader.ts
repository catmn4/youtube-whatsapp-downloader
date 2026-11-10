import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { WAMessage } from "@whiskeysockets/baileys";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(process.cwd());
const maxMetadataOutputBytes = 8 * 1024 * 1024;

type TextContent = {
  conversation?: string | null;
  extendedTextMessage?: { text?: string | null } | null;
  imageMessage?: { caption?: string | null } | null;
  videoMessage?: { caption?: string | null } | null;
  documentMessage?: { caption?: string | null } | null;
  ephemeralMessage?: { message?: TextContent | null } | null;
  viewOnceMessage?: { message?: TextContent | null } | null;
  viewOnceMessageV2?: { message?: TextContent | null } | null;
  documentWithCaptionMessage?: { message?: TextContent | null } | null;
};

export type ParsedYoutubeCommand =
  | { kind: "not-command" }
  | { kind: "help" }
  | { kind: "list-formats"; url: string; valid: boolean }
  | { kind: "select-formats"; videoIndex: number; audioIndex: number }
  | { kind: "invalid" };

export type YoutubeFormatChoice = {
  formatId: string;
  label: string;
  exactSizeBytes: number;
};

export type YoutubeFormatMenu = {
  url: string;
  title: string;
  durationSeconds?: number;
  video: YoutubeFormatChoice[];
  audio: YoutubeFormatChoice[];
};

export type YoutubeDownloadResult = {
  filePath: string;
  title: string;
  directory: string;
  fileSizeBytes: number;
  mediaKind: "video" | "audio" | "video-audio";
};

type YtDlpFormat = {
  format_id?: string;
  ext?: string;
  height?: number | null;
  fps?: number | null;
  vcodec?: string;
  acodec?: string;
  abr?: number | null;
  tbr?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  format_note?: string;
  url?: string;
};

type YtDlpInfo = {
  title?: string;
  duration?: number;
  formats?: YtDlpFormat[];
};

export function extractYoutubeMessageText(message: WAMessage): string {
  let content = message.message as TextContent | null | undefined;
  for (let depth = 0; content && depth < 5; depth += 1) {
    if (content.conversation) return content.conversation;
    if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
    if (content.imageMessage?.caption) return content.imageMessage.caption;
    if (content.videoMessage?.caption) return content.videoMessage.caption;
    if (content.documentMessage?.caption) return content.documentMessage.caption;
    content =
      content.ephemeralMessage?.message ??
      content.viewOnceMessage?.message ??
      content.viewOnceMessageV2?.message ??
      content.documentWithCaptionMessage?.message;
  }
  return "";
}

export function parseYoutubeCommand(text: string): ParsedYoutubeCommand {
  const match = text.trim().match(/^[/!](?:yt|youtube)(?:\s+([\s\S]*))?$/i);
  if (!match) return { kind: "not-command" };
  const args = (match[1] ?? "").trim();
  if (!args || /^help$/i.test(args)) return { kind: "help" };
  const parts = args.split(/\s+/);
  if (parts.length === 1 && !/^\d+$/.test(parts[0] ?? "")) {
    const url = parts[0] ?? "";
    return { kind: "list-formats", url, valid: isYoutubeUrl(url) };
  }
  if (parts.length === 2 && parts.every((part) => /^\d+$/.test(part))) {
    const [videoIndex, audioIndex] = parts.map(Number);
    if (Number.isSafeInteger(videoIndex) && Number.isSafeInteger(audioIndex)) {
      return { kind: "select-formats", videoIndex, audioIndex };
    }
  }
  return { kind: "invalid" };
}

export function isYoutubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.searchParams.has("list")) {
      return false;
    }
    if (host === "youtu.be") return /^\/[\w-]+\/?$/.test(url.pathname);
    if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
      return false;
    }
    if (url.pathname === "/watch") return Boolean(url.searchParams.get("v"));
    return /^\/(?:shorts|live|embed|v)\/[\w-]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function isYoutubeSenderAllowed(senderJid: string, allowlist: string): boolean {
  if (!senderJid.endsWith("@s.whatsapp.net")) return false;
  const senderLocalPart = senderJid.split("@")[0]?.split(":")[0] ?? "";
  const senderNumber = senderLocalPart.replace(/\D/g, "");
  if (!senderNumber) return false;
  const allowedNumbers = allowlist
    .split(",")
    .map((value) => value.trim().replace(/\D/g, ""))
    .filter(Boolean);
  return allowedNumbers.includes(senderNumber);
}

function configuredPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function concatenateParts(name: "ffmpeg" | "ffprobe", destination: string): Promise<void> {
  const partsDir = join(projectRoot, "vendor", "parts");
  const parts = (await readdir(partsDir)).filter((part) => part.startsWith(`${name}.part-`)).sort();
  if (parts.length === 0) throw new Error(`الأجزاء المطلوبة للأداة ${name} غير موجودة.`);
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { force: true });
  for (const [index, part] of parts.entries()) {
    await pipeline(
      createReadStream(join(partsDir, part)),
      createWriteStream(destination, { flags: index === 0 ? "w" : "a" }),
    );
  }
  await chmod(destination, 0o755);
}

async function resolveTools(
  requireFfmpeg = true,
): Promise<{ ytdlp: string; ffmpegDirectory: string }> {
  const configuredYtdlp = process.env.YTDLP_PATH?.trim();
  const configuredTools = process.env.TOOLS_DIR?.trim();
  const vendorDirectory = join(projectRoot, "vendor");
  const runtimeTools = join(projectRoot, ".runtime-tools");
  const ytdlp = configuredYtdlp ? resolve(configuredYtdlp) : join(vendorDirectory, "yt-dlp");
  let ffmpegDirectory = configuredTools ? resolve(configuredTools) : vendorDirectory;

  if (
    (process.platform !== "linux" || process.arch !== "x64") &&
    (!configuredYtdlp || (requireFfmpeg && !configuredTools))
  ) {
    throw new Error(
      "الأدوات المضمّنة تعمل على Linux x86_64 فقط؛ اضبط YTDLP_PATH وTOOLS_DIR لأدوات متوافقة.",
    );
  }
  if (!(await isExecutable(ytdlp))) {
    throw new Error("لم يتم العثور على yt-dlp قابل للتشغيل. راجع YTDLP_PATH أو مجلد vendor/.");
  }
  if (requireFfmpeg && !configuredTools) {
    const bundledFfmpeg = join(vendorDirectory, "ffmpeg");
    const bundledFfprobe = join(vendorDirectory, "ffprobe");
    if (!(await isExecutable(bundledFfmpeg)) || !(await isExecutable(bundledFfprobe))) {
      ffmpegDirectory = runtimeTools;
      await concatenateParts("ffmpeg", join(runtimeTools, "ffmpeg"));
      await concatenateParts("ffprobe", join(runtimeTools, "ffprobe"));
    }
  }
  if (requireFfmpeg && !(await isExecutable(join(ffmpegDirectory, "ffmpeg")))) {
    throw new Error(
      "لم يتم العثور على ffmpeg. اضبط TOOLS_DIR إلى المجلد الذي يحتوي ffmpeg وffprobe.",
    );
  }
  return { ytdlp, ffmpegDirectory };
}

async function runYtDlp(
  executable: string,
  args: string[],
  timeoutMs: number,
  maxBuffer = maxMetadataOutputBytes,
): Promise<string> {
  const result = await execFileAsync(executable, args, {
    cwd: projectRoot,
    timeout: timeoutMs,
    maxBuffer,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout;
}

function isGoogleVideoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "googlevideo.com" || url.hostname.endsWith(".googlevideo.com"))
    );
  } catch {
    return false;
  }
}

async function getExactRemoteSize(formatUrl: string): Promise<number | null> {
  if (!isGoogleVideoUrl(formatUrl)) return null;
  let currentUrl = formatUrl;
  for (let redirectCount = 0; redirectCount < 3; redirectCount += 1) {
    let response: Response | undefined;
    try {
      response = await fetch(currentUrl, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        redirect: "manual",
        signal: AbortSignal.timeout(12_000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) return null;
        const nextUrl = new URL(location, currentUrl).toString();
        if (!isGoogleVideoUrl(nextUrl)) return null;
        currentUrl = nextUrl;
        continue;
      }
      if (response.status === 206) {
        const range = response.headers.get("content-range") ?? "";
        const totalBytes = Number(range.match(/^bytes\s+\d+-\d+\/(\d+)$/i)?.[1]);
        return Number.isSafeInteger(totalBytes) && totalBytes > 0 ? totalBytes : null;
      }
      if (response.status === 200) {
        const contentLength = Number(response.headers.get("content-length"));
        return Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : null;
      }
      return null;
    } catch {
      return null;
    } finally {
      await response?.body?.cancel().catch(() => undefined);
    }
  }
  return null;
}

function formatPreference(format: YtDlpFormat): number {
  return (
    (format.ext === "mp4" || format.ext === "m4a" ? 100 : 0) +
    (format.vcodec?.startsWith("avc1") || format.acodec?.startsWith("mp4a") ? 20 : 0)
  );
}

function exactBytes(format: YtDlpFormat): number | null {
  // Deliberately never fall back to filesize_approx: menu sizes must be exact.
  return Number.isSafeInteger(format.filesize) && (format.filesize ?? 0) > 0
    ? (format.filesize as number)
    : null;
}

async function toExactChoices(
  formats: YtDlpFormat[],
  mediaKind: "video" | "audio",
): Promise<YoutubeFormatChoice[]> {
  const choices: Array<YoutubeFormatChoice | null> = Array.from(
    { length: formats.length },
    () => null,
  );
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(4, formats.length) }, async () => {
    while (nextIndex < formats.length) {
      const index = nextIndex;
      nextIndex += 1;
      const format = formats[index];
      if (!format?.format_id || !/^[\w.-]+$/.test(format.format_id)) continue;
      const bytes =
        exactBytes(format) ?? (format.url ? await getExactRemoteSize(format.url) : null);
      if (!bytes) continue;
      const ext = format.ext || "unknown";
      if (mediaKind === "video") {
        const fps = format.fps ? ` ${Math.round(format.fps)}fps` : "";
        const codec = (format.vcodec ?? "").split(".")[0];
        choices[index] = {
          formatId: format.format_id,
          label: `${format.height}p${fps} · ${ext} · ${codec}`,
          exactSizeBytes: bytes,
        };
      } else {
        const bitrate = Math.round(format.abr ?? format.tbr ?? 0);
        const codec = (format.acodec ?? "").split(".")[0];
        choices[index] = {
          formatId: format.format_id,
          label: `${ext} · ${codec}${bitrate > 0 ? ` · ${bitrate} kbps` : ""}`,
          exactSizeBytes: bytes,
        };
      }
    }
  });
  await Promise.all(workers);
  return choices.filter((choice): choice is YoutubeFormatChoice => choice !== null);
}

export async function getYoutubeFormatMenu(url: string): Promise<YoutubeFormatMenu> {
  if (!isYoutubeUrl(url)) throw new Error("الرابط غير صالح؛ أرسل رابط فيديو YouTube واحداً.");
  const { ytdlp } = await resolveTools(false);
  const output = await runYtDlp(
    ytdlp,
    ["--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings", url],
    90_000,
  );
  let metadata: YtDlpInfo;
  try {
    metadata = JSON.parse(output) as YtDlpInfo;
  } catch {
    throw new Error("تعذر قراءة بيانات الفيديو التي أعادها yt-dlp.");
  }
  const durationSeconds = metadata.duration;
  const maxDurationSeconds = configuredPositiveInteger("YOUTUBE_WA_MAX_DURATION_SECONDS", 1800);
  if (typeof durationSeconds === "number" && durationSeconds > maxDurationSeconds) {
    throw new Error(
      `مدة الفيديو تتجاوز الحد المسموح (${Math.floor(maxDurationSeconds / 60)} دقيقة).`,
    );
  }

  const videoByQuality = new Map<string, YtDlpFormat>();
  const audioByQuality = new Map<string, YtDlpFormat>();
  for (const format of metadata.formats ?? []) {
    if (format.vcodec && format.vcodec !== "none" && format.acodec === "none" && format.height) {
      const key = `${format.height}:${Math.round(format.fps ?? 0)}:${format.ext ?? "unknown"}`;
      const current = videoByQuality.get(key);
      if (!current || formatPreference(format) > formatPreference(current))
        videoByQuality.set(key, format);
    }
    if (format.acodec && format.acodec !== "none" && format.vcodec === "none") {
      const bitrate = Math.round(format.abr ?? format.tbr ?? 0);
      const key = `${bitrate}:${format.ext ?? "unknown"}`;
      const current = audioByQuality.get(key);
      if (!current || formatPreference(format) > formatPreference(current))
        audioByQuality.set(key, format);
    }
  }

  const videoCandidates = [...videoByQuality.values()]
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.fps ?? 0) - (a.fps ?? 0))
    .slice(0, 16);
  const audioCandidates = [...audioByQuality.values()]
    .sort(
      (a, b) =>
        (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0) || formatPreference(b) - formatPreference(a),
    )
    .slice(0, 12);
  const [video, audio] = await Promise.all([
    toExactChoices(videoCandidates, "video"),
    toExactChoices(audioCandidates, "audio"),
  ]);

  return {
    url,
    title: (metadata.title ?? "فيديو YouTube").replace(/[\r\n\t]/g, " ").slice(0, 160),
    ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
    video,
    audio,
  };
}

function exactSizeLabel(bytes: number): string {
  const exactBytes = new Intl.NumberFormat("en-US").format(bytes);
  return `${exactBytes} بايت (${(bytes / (1024 * 1024)).toFixed(2)} MiB)`;
}

export function renderYoutubeFormatMenu(menu: YoutubeFormatMenu): string {
  const lines = [`الفيديو: ${menu.title}`];
  lines.push("أحجام الملفات أدناه دقيقة بالبايت؛ لم تُستخدم الأحجام التقريبية.");
  lines.push("جودات الفيديو (اختر الرقم الأول):");
  if (menu.video.length === 0) lines.push("لا توجد صيغ فيديو أمكن التحقق من حجمها الدقيق.");
  for (const [index, choice] of menu.video.entries()) {
    lines.push(`${index + 1}) ${choice.label} — ${exactSizeLabel(choice.exactSizeBytes)}`);
  }
  lines.push("جودات الصوت (اختر الرقم الثاني):");
  if (menu.audio.length === 0) lines.push("لا توجد صيغ صوت أمكن التحقق من حجمها الدقيق.");
  for (const [index, choice] of menu.audio.entries()) {
    lines.push(`${index + 1}) ${choice.label} — ${exactSizeLabel(choice.exactSizeBytes)}`);
  }
  lines.push("أرسل: !yt رقم_الفيديو رقم_الصوت — مثال: !yt 3 5");
  lines.push("أرسل 0 لأحد الرقمين لاستبعاد ذلك المسار والاكتفاء بالآخر؛ لا تستخدم 0 0.");
  return lines.join("\n");
}

export async function downloadYoutubeSelection(
  menu: YoutubeFormatMenu,
  videoChoice: YoutubeFormatChoice | null,
  audioChoice: YoutubeFormatChoice | null,
): Promise<YoutubeDownloadResult> {
  if (!videoChoice && !audioChoice) throw new Error("يجب اختيار مسار فيديو أو صوت واحد على الأقل.");
  if (!isYoutubeUrl(menu.url)) throw new Error("الرابط غير صالح؛ أرسل رابط فيديو YouTube واحداً.");
  const maxSizeMb = configuredPositiveInteger("YOUTUBE_WA_MAX_SIZE_MB", 100);
  const requestedBytes = (videoChoice?.exactSizeBytes ?? 0) + (audioChoice?.exactSizeBytes ?? 0);
  if (requestedBytes > maxSizeMb * 1024 * 1024) {
    throw new Error(`مجموع أحجام المسارات يتجاوز الحد المسموح (${maxSizeMb} ميغابايت).`);
  }
  const needsMerge = Boolean(videoChoice && audioChoice);
  const { ytdlp, ffmpegDirectory } = await resolveTools(needsMerge);
  const formatSelector =
    videoChoice && audioChoice
      ? `${videoChoice.formatId}+${audioChoice.formatId}`
      : (videoChoice?.formatId ?? audioChoice?.formatId ?? "");
  const directory = join(projectRoot, "data", "youtube-downloads", randomUUID());
  await mkdir(directory, { recursive: true });
  try {
    const args = [
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--format",
      formatSelector,
      "--max-filesize",
      `${maxSizeMb}M`,
      "--output",
      join(directory, "%(id)s.%(ext)s"),
    ];
    if (needsMerge) {
      args.push("--ffmpeg-location", ffmpegDirectory, "--merge-output-format", "mp4");
    }
    args.push(menu.url);
    await runYtDlp(ytdlp, args, 20 * 60_000, 2 * 1024 * 1024);

    const files = (await readdir(directory)).filter((file) => !file.endsWith(".part"));
    if (files.length !== 1) throw new Error("لم ينتج التنزيل ملفاً واحداً صالحاً.");
    const filePath = join(directory, files[0] ?? "");
    const fileInfo = await stat(filePath);
    if (fileInfo.size > maxSizeMb * 1024 * 1024) {
      throw new Error(`حجم الملف النهائي يتجاوز الحد المسموح (${maxSizeMb} ميغابايت).`);
    }
    return {
      filePath,
      title: menu.title,
      directory,
      fileSizeBytes: fileInfo.size,
      mediaKind: videoChoice && audioChoice ? "video-audio" : videoChoice ? "video" : "audio",
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof Error && "killed" in error && error.killed) {
      throw new Error("انتهت مهلة التنزيل؛ حاول اختيار مسارات أصغر.");
    }
    throw error;
  }
}

export async function removeYoutubeDownload(directory: string): Promise<void> {
  const downloadRoot = join(projectRoot, "data", "youtube-downloads");
  const resolvedDirectory = resolve(directory);
  if (!resolvedDirectory.startsWith(`${resolve(downloadRoot)}/`)) {
    throw new Error("رفض حذف مسار خارج مجلد التنزيلات المؤقتة.");
  }
  await rm(resolvedDirectory, { recursive: true, force: true });
}

export function youtubeMimeType(filePath: string): string {
  return extname(filePath).toLowerCase() === ".webm" ? "video/webm" : "video/mp4";
}

export function youtubeAudioMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".webm") return "audio/webm";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".opus" || ext === ".ogg") return "audio/ogg";
  return "audio/mp4";
}
