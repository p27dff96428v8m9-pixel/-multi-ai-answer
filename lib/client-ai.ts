import {
  AiAnswer,
  AnalysisResult,
  ConsultationCategory,
  ProviderConfig,
  UsageMode,
} from "@/lib/dummy-ai";

type ClientAskInput = {
  question: string;
  category: ConsultationCategory;
  mode: UsageMode;
  providers: ProviderConfig[];
  customKeys: Record<string, string>;
};

type ProviderCallResult = {
  provider: ProviderConfig;
  content?: string;
  error?: string;
};

export async function askAdvancedProviders(input: ClientAskInput): Promise<AnalysisResult> {
  const activeProviders = input.providers.filter((provider) => provider.enabled && provider.origin === "custom");
  const results = await Promise.all(
    activeProviders.map((provider) => callProvider(provider, input.category, input.question, input.customKeys[provider.id] ?? "")),
  );
  const answers = results.map((result, index) => toAnswer(result, index));

  return {
    question: input.question,
    category: input.category,
    mode: input.mode,
    answers,
    conclusion: buildConclusion(input.question, input.category, answers),
    generatedAt: new Date().toISOString(),
  };
}

export function getSimpleRelayUrl() {
  const raw = process.env.NEXT_PUBLIC_SIMPLE_RELAY_URL?.trim();
  return raw ? raw.replace(/\/$/, "") : "";
}

export async function askSimpleRelay(input: Omit<ClientAskInput, "customKeys">): Promise<AnalysisResult> {
  const relay = getSimpleRelayUrl();
  const protocol = globalThis.location?.protocol ?? "";
  if (!relay && protocol.startsWith("capacitor")) {
    throw new Error("APKの簡単モードでは、NEXT_PUBLIC_SIMPLE_RELAY_URL に公開中継サーバーのURLを設定してビルドする必要があります。");
  }

  const endpoint = relay ? `${relay}/api/ask` : "/api/ask";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, customKeys: {} }),
  });
  const text = await response.text();
  const data = parseApiResponse(text);
  if (!response.ok) throw new Error(publicProviderError("simple", data.error ?? text, response.status));
  return data as AnalysisResult;
}

async function callProvider(provider: ProviderConfig, category: ConsultationCategory, question: string, apiKey: string): Promise<ProviderCallResult> {
  const key = apiKey.trim();
  if (!key) return { provider, error: publicProviderError("advanced", "missing api key", 401) };

  if (provider.id === "openai") return callOpenAI(provider, category, question, key);
  if (provider.id === "anthropic") return callAnthropic(provider, category, question, key);
  if (provider.id === "gemini") return callGemini(provider, category, question, key);
  if (provider.id === "openrouter") return callOpenRouter(provider, category, question, key);
  if (provider.id === "deepseek") return callDeepSeek(provider, category, question, key);

  return { provider, error: `${provider.name}: ブラウザからの直接呼び出しは未対応です。` };
}

async function callOpenAI(provider: ProviderConfig, category: ConsultationCategory, question: string, apiKey: string): Promise<ProviderCallResult> {
  const model = "gpt-4.1-mini";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: systemInstruction(),
      input: buildPrompt(question, provider),
      temperature: 0.4,
      max_output_tokens: 700,
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { output_text?: string; model?: string };
  const content = data.output_text?.trim();
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "OpenAIからテキスト回答を取得できませんでした。" };
}

async function callAnthropic(provider: ProviderConfig, category: ConsultationCategory, question: string, apiKey: string): Promise<ProviderCallResult> {
  const model = "claude-sonnet-4-5";
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      system: systemInstruction(),
      messages: [{ role: "user", content: buildPrompt(question, provider) }],
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { content?: Array<{ text?: string }>; model?: string };
  const content = data.content?.map((item) => item.text ?? "").join("").trim();
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "Claudeからテキスト回答を取得できませんでした。" };
}

async function callGemini(provider: ProviderConfig, category: ConsultationCategory, question: string, apiKey: string): Promise<ProviderCallResult> {
  const model = "gemini-2.5-flash";
  const first = await callGeminiModel(provider, question, apiKey, model, false);
  if (first.content && scoreAnswer(cleanAnswerText(first.content)) >= 65) return first;
  if (first.content) return callGeminiModel(provider, question, apiKey, model, true);
  return first;
}

async function callGeminiModel(provider: ProviderConfig, question: string, apiKey: string, model: string, retry: boolean): Promise<ProviderCallResult> {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${systemInstruction()}\n\n${retry ? "前回の回答が短すぎるか未完成でした。挨拶なしで、結論から、具体例を含めて最後まで回答してください。\n\n" : ""}${buildPrompt(question, provider)}` }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 700 },
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const content = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  return content ? { provider: { ...provider, model }, content } : { provider, error: "Geminiからテキスト回答を取得できませんでした。" };
}

async function callOpenRouter(provider: ProviderConfig, category: ConsultationCategory, question: string, apiKey: string): Promise<ProviderCallResult> {
  const model = "openrouter/auto";
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": globalThis.location?.origin ?? "capacitor://localhost",
      "X-Title": "AI Multi Answer",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemInstruction() },
        { role: "user", content: buildPrompt(question, provider) },
      ],
      temperature: 0.4,
      max_tokens: 700,
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (content && englishRatio(content) > 0.18) return { provider: { ...provider, model }, error: "日本語以外の回答が多いため再試行します。" };
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "OpenRouterからテキスト回答を取得できませんでした。" };
}

async function callDeepSeek(provider: ProviderConfig, category: ConsultationCategory, question: string, apiKey: string): Promise<ProviderCallResult> {
  const model = "deepseek-chat";
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemInstruction() },
        { role: "user", content: buildPrompt(question, provider) },
      ],
      temperature: 0.4,
      max_tokens: 700,
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (content && englishRatio(content) > 0.18) return { provider: { ...provider, model }, error: "日本語以外の回答が多いため再試行します。" };
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "DeepSeekからテキスト回答を取得できませんでした。" };
}

function systemInstruction() {
  return "日本語のみで回答してください。挨拶、自己紹介、Markdown、表は使わず、質問に直接答えてください。結論から書き、具体例を含め、途中で終わらせないでください。";
}

function buildPrompt(question: string, provider: ProviderConfig) {
  return [providerPrompt(provider), "", "質問:", question].join("\n");
}

function providerPrompt(provider: ProviderConfig) {
  if (provider.id === "gemini" || provider.id === "gemini-free") {
    return [
      "役割: 整理初心者向け解説担当。",
      "わかりやすさと読みやすさを最優先し、専門用語を減らしてください。",
      "自己紹介、挨拶、キャラ口調は禁止です。",
      "通常質問は250〜450文字、開発専門質問は400〜900文字を目安にしてください。",
      "必ず質問に直接答え、具体例を1つ以上入れてください。",
    ].join("\n");
  }
  if (provider.id === "openrouter" || provider.id === "openrouter-free") {
    return [
      "役割: 批判補足リスク担当。",
      "別視点、注意点、デメリット、セキュリティ、リスクを中心に答えてください。",
      "必ず自然な日本語のみで回答し、英語や翻訳調を避けてください。",
      "Markdown、表、英語見出しは禁止です。",
    ].join("\n");
  }
  if (provider.id === "qwen-free") {
    return [
      "役割: 技術実装具体例担当。",
      "具体例、実装手順、現実的な進め方を深く説明してください。",
      "開発系の質問では詳細な説明を歓迎します。",
      "日本語のみで回答し、Markdown記号や表は使わないでください。",
    ].join("\n");
  }
  return "以下の質問に、分かりやすく実用的に答えてください。";
}

function toAnswer(result: ProviderCallResult, index: number): AiAnswer {
  const hasError = Boolean(result.error);
  const content = cleanAnswerText(result.content ?? "");
  const summary = hasError ? "このAIは現在利用できません。APIキー設定または認証設定を確認してください。" : firstParagraph(content);
  const score = hasError ? 0 : scoreAnswer(content);
  return {
    id: result.provider.id,
    name: result.provider.name,
    model: result.provider.model,
    role: result.provider.role,
    status: hasError ? "error" : "complete",
    confidence: score,
    summary,
    bullets: hasError ? [result.error ?? publicProviderError("advanced")] : extractBullets(content, summary),
    costLabel: result.provider.costLabel,
    origin: result.provider.origin,
    errorMessage: result.error,
  };
}

function buildConclusion(question: string, category: ConsultationCategory, answers: AiAnswer[]): AnalysisResult["conclusion"] {
  const completed = answers.filter((answer) => answer.status === "complete");
  const failed = answers.filter((answer) => answer.status === "error");
  const safetyNote =
    category === "health"
      ? "これは一般的な健康・食事情報であり、診断や治療ではありません。強い症状や長引く不調がある場合は専門家に相談してください。"
      : undefined;

  if (completed.length === 0) {
    return {
      recommendation: "有効なAPIキーを設定してから再実行してください。",
      reason: "詳細モードでは、入力されたユーザーAPIキーを使って各AIへ直接問い合わせます。",
      alternatives: ["別のAIキーを使う", "簡単モードで中継サーバーを使う", "キーを保存せず今回だけ入力する"],
      cautions: failed.map((answer) => `${answer.name}: ${answer.errorMessage ?? publicProviderError("advanced")}`),
      safetyNote,
    };
  }

  const ranked = [...completed].sort((a, b) => b.confidence - a.confidence);
  const best = ranked[0];
  const supplements = ranked.slice(1).map((answer) => `${answer.name}: ${answer.summary}`).slice(0, 2);
  const adoptionReasons = adoptionReasonLabels(best, ranked);

  return {
    recommendation: buildFinalRecommendation(best, supplements),
    reason: adoptionReasons.join(" / "),
    alternatives: buildPeerReviews(ranked),
    cautions: [...failed.map((answer) => `${answer.name}: 利用できなかったため不採用`), ...ranked.slice(1).map((answer) => `${answer.name}: ${nonAdoptionReason(answer, best)}`)].slice(0, 4),
    safetyNote,
  };
}

function firstParagraph(text: string) {
  return text.split(/\n{2,}/).find(Boolean)?.replace(/^[-*\d.\s]+/, "").trim() || text.slice(0, 180);
}

function extractBullets(text: string, summary: string) {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter((line) => line && line !== summary);
  return Array.from(new Set(lines)).slice(0, 4);
}

function cleanAnswerText(text: string) {
  return text
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\|/g, " ")
    .trim();
}

function scoreAnswer(text: string) {
  const length = text.length;
  const sentenceCount = (text.match(/。/g) ?? []).length;
  const hasExample = /例えば|例として|具体例|手順|まず|次に|場合/.test(text);
  const englishRatioValue = englishRatio(text);
  const incomplete = /説明します。?$|以下です。?$|紹介します。?$|[:：]\s*$/.test(text) || sentenceCount < 2;
  let score = 58;
  if (length >= 220) score += 12;
  if (length >= 400) score += 8;
  if (sentenceCount >= 4) score += 8;
  if (hasExample) score += 8;
  if (englishRatioValue > 0.18) score -= 12;
  if (incomplete) score -= 20;
  return Math.max(45, Math.min(96, score));
}

function englishRatio(text: string) {
  return (text.match(/[A-Za-z]/g)?.length ?? 0) / Math.max(1, text.length);
}

function buildFinalRecommendation(best: AiAnswer, supplements: string[]) {
  const base = best.summary.replace(/\s+/g, " ");
  const extra = supplements.length ? `補足として、${supplements.join("。")}` : "";
  return trimToLength(`${base}${extra ? ` ${extra}` : ""}`, 350);
}

function trimToLength(text: string, max: number) {
  if (text.length <= max) return text;
  const sliced = text.slice(0, max);
  const lastPeriod = sliced.lastIndexOf("。");
  return `${(lastPeriod > 160 ? sliced.slice(0, lastPeriod + 1) : sliced).trim()}…`;
}

function adoptionReasonLabels(best: AiAnswer, ranked: AiAnswer[]) {
  const reasons = ["質問への適合度が高い", "内容の完成度が高い"];
  if (best.confidence >= 82) reasons.push("具体性が高い");
  if (ranked.length > 1) reasons.push("他AIの補足と統合しやすい");
  return reasons.slice(0, 4);
}

function buildPeerReviews(ranked: AiAnswer[]) {
  if (ranked.length <= 1) return ["他AIの有効回答が少ないため、成功した回答を中心に整理しました。"];
  return ranked.slice(0, 3).map((answer, index) => {
    if (index === 0) return `${answer.name}: 最も完成度が高く、最終結論の土台に採用`;
    return `${answer.name}: 有用な補足として一部採用`;
  });
}

function nonAdoptionReason(answer: AiAnswer, best: AiAnswer) {
  if (answer.confidence + 8 < best.confidence) return "内容密度または完成度で主採用には届かなかった";
  return "主結論ではなく補足意見として採用";
}

function parseApiResponse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("中継サーバーから正常な応答を取得できませんでした。時間を置いて再試行してください。");
  }
}

async function sanitizeProviderError(response: Response, mode: "simple" | "advanced") {
  const text = await response.text();
  return publicProviderError(mode, text, response.status);
}

function publicProviderError(mode: "simple" | "advanced", raw = "", status?: number) {
  if (status === 401 || /missing authentication|unauthorized|401|missing api key/i.test(raw)) {
    return mode === "simple"
      ? "このAIは現在利用できません。中継サーバー側の認証設定が必要です。"
      : "このAIは現在利用できません。APIキーが未入力、または認証情報が正しくない可能性があります。";
  }

  return mode === "simple"
    ? "このAIは現在一時的に利用できません。他のAIの回答をご確認ください。"
    : "このAIは現在利用できません。APIキー設定または認証設定を確認してください。";
}
