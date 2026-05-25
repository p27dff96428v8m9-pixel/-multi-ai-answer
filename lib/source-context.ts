export type SourceContext = {
  kind: "youtube";
  url: string;
  videoId: string;
  title?: string;
  author?: string;
  description?: string;
  transcript?: string;
  unavailableReason?: string;
};

type OEmbedResponse = {
  title?: string;
  author_name?: string;
};

type CaptionTrack = {
  baseUrl?: string;
  languageCode?: string;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
};

export function findYouTubeUrl(input: string) {
  return input.match(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^ \n]+|youtu\.be\/[A-Za-z0-9_-]{6,})/i)?.[0] ?? "";
}

export function extractYouTubeVideoId(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtu.be")) return parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    return parsed.searchParams.get("v") ?? "";
  } catch {
    return "";
  }
}

export async function resolveSourceContext(input: string): Promise<SourceContext | null> {
  if (input.includes("参照URLの取得済み情報:")) return null;
  const url = findYouTubeUrl(input);
  if (!url) return null;

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return {
      kind: "youtube",
      url,
      videoId: "",
      unavailableReason: "YouTube URLから動画IDを取得できませんでした。",
    };
  }

  const context: SourceContext = { kind: "youtube", url, videoId };
  await Promise.all([loadYouTubeOEmbed(context), loadYouTubeWatchPage(context)]);

  if (!context.title && !context.description && !context.transcript) {
    context.unavailableReason = "YouTubeの公開メタ情報を取得できませんでした。動画内容を見た前提の回答はできません。";
  } else if (!context.transcript) {
    context.unavailableReason = "字幕を取得できませんでした。タイトル、概要欄、メタ情報だけを根拠にします。";
  }

  return context;
}

export function attachSourceContextToQuestion(question: string, source: SourceContext | null) {
  if (!source) return question;

  const lines = [
    question,
    "",
    "参照URLの取得済み情報:",
    `URL: ${source.url}`,
    source.title ? `タイトル: ${source.title}` : "",
    source.author ? `投稿者: ${source.author}` : "",
    source.description ? `概要欄/説明: ${trim(source.description, 1200)}` : "",
    source.transcript ? `字幕/文字起こし: ${trim(source.transcript, 2500)}` : "",
    source.unavailableReason ? `取得制限: ${source.unavailableReason}` : "",
    "",
    "厳守: AIは動画を直接見ていません。上の取得済み情報だけを根拠にし、不明な内容を推測で補完しないでください。",
  ].filter(Boolean);

  return lines.join("\n");
}

async function loadYouTubeOEmbed(context: SourceContext) {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(context.url)}&format=json`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
    const data = (await response.json()) as OEmbedResponse;
    context.title ||= data.title?.trim();
    context.author ||= data.author_name?.trim();
  } catch {
    return;
  }
}

async function loadYouTubeWatchPage(context: SourceContext) {
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(context.videoId)}`, {
      headers: { Accept: "text/html", "Accept-Language": "ja,en;q=0.8" },
    });
    if (!response.ok) return;
    const html = await response.text();
    context.title ||= decodeHtml(extractMeta(html, "title"));
    context.description ||= decodeHtml(extractMeta(html, "description"));
    context.transcript ||= await loadCaptionText(html);
  } catch {
    return;
  }
}

async function loadCaptionText(html: string) {
  const playerResponse = extractPlayerResponse(html);
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks as CaptionTrack[] | undefined;
  if (!tracks?.length) return "";

  const selected = tracks.find((track) => track.languageCode === "ja") ?? tracks.find((track) => track.languageCode?.startsWith("en")) ?? tracks[0];
  if (!selected?.baseUrl) return "";

  try {
    const response = await fetch(selected.baseUrl);
    if (!response.ok) return "";
    const xml = await response.text();
    return decodeHtml(
      Array.from(xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g))
        .map((match) => match[1].replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" "),
    );
  } catch {
    return "";
  }
}

function extractPlayerResponse(html: string): any {
  const marker = "ytInitialPlayerResponse = ";
  const index = html.indexOf(marker);
  if (index < 0) return null;
  const start = index + marker.length;
  const end = html.indexOf(";</script>", start);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    return null;
  }
}

function extractMeta(html: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["'](?:og:)?${escaped}["'][^>]+content=["']([^"']*)["']`, "i");
  return html.match(pattern)?.[1] ?? "";
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function trim(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max).trim()}...` : value;
}
