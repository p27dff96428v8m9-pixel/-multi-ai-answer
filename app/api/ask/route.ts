import { NextRequest, NextResponse } from "next/server";
import { AiAnswer, AnalysisResult, ConsultationCategory, ProviderConfig, UsageMode, builtInProviders } from "@/lib/dummy-ai";
import { detectPrivacyRisks } from "@/lib/privacy-guard";
import { checkDailyLimit, getClientKey, usageLimits } from "@/lib/usage-limits";

export const runtime = "nodejs";
export const dynamic = "force-static";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

type AskRequest = {
  question: string;
  category: ConsultationCategory;
  mode: UsageMode;
  providers?: ProviderConfig[];
};

type ProviderCallResult = {
  provider: ProviderConfig;
  content?: string;
  error?: string;
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as AskRequest;
    const question = body.question?.trim();
    const category = body.category ?? "development";

    if (!question) {
      return json({ error: "質問を入力してください。" }, 400);
    }

    if (question.length > usageLimits.maxQuestionLength) {
      return json({ error: `質問が長すぎます。${usageLimits.maxQuestionLength}文字以内にしてください。` }, 400);
    }

    const privacyRisks = detectPrivacyRisks(question);
    if (privacyRisks.length > 0) {
      return json({ error: "個人情報やAPIキーなどの機密情報が含まれている可能性があります。伏せ字にしてから送信してください。", risks: privacyRisks }, 400);
    }

    const usage = checkDailyLimit(`simple:${getClientKey(request)}`, usageLimits.dailySimpleRequests);
    if (!usage.allowed) {
      return json({ error: `本日の簡単モード上限 ${usage.limit} 回に達しました。`, usage }, 429);
    }

    const providers = normalizeProviders(body.providers);
    const results = await Promise.all(providers.map((provider) => callBuiltInProvider(provider, question)));
    const answers = results.map((result, index) => toAnswer(result, index));

    const response: AnalysisResult = {
      question,
      category,
      mode: "simple",
      answers,
      conclusion: buildConclusion(question, category, answers),
      generatedAt: new Date().toISOString(),
    };

    return json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明なエラーが発生しました。";
    return json({ error: message }, 500);
  }
}

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: corsHeaders });
}

function normalizeProviders(incoming: ProviderConfig[] | undefined) {
  const enabled = (incoming?.length ? incoming : builtInProviders).filter((provider) => provider.enabled && provider.origin === "built-in");
  return enabled.slice(0, Math.max(1, usageLimits.simpleProviderLimit));
}

async function callBuiltInProvider(provider: ProviderConfig, question: string): Promise<ProviderCallResult> {
  if (provider.id === "gemini-free") return callGemini(provider, question);
  if (provider.id === "openrouter-free" || provider.id === "qwen-free") return callOpenRouter(provider, question);
  return { provider, error: `${provider.name} は簡単モードの中継サーバーで未対応です。` };
}

async function callGemini(provider: ProviderConfig, question: string): Promise<ProviderCallResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { provider, error: publicProviderError("simple") };

  const model = process.env.GEMINI_MODEL || provider.model;
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

  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "simple") };
  const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const content = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  return content ? { provider: { ...provider, model }, content } : { provider: { ...provider, model }, error: "Geminiからテキスト回答を取得できませんでした。" };
}

async function callOpenRouter(provider: ProviderConfig, question: string): Promise<ProviderCallResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { provider, error: publicProviderError("simple") };

  const models = provider.id === "qwen-free" ? thirdFreeModelCandidates(provider) : openRouterModelCandidates(provider);
  let lastError = publicProviderError("simple");

  for (const model of models) {
    const result = await callOpenRouterModel(provider, question, apiKey, model);
    if (result.content) return result;
    lastError = result.error ?? lastError;
  }

  return { provider, error: lastError };
}

async function callOpenRouterModel(provider: ProviderConfig, question: string, apiKey: string, model: string): Promise<ProviderCallResult> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
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

  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "simple") };
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (content && englishRatio(content) > 0.18) return { provider: { ...provider, model }, error: "日本語以外の回答が多いため再試行します。" };
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider: { ...provider, model }, error: "OpenRouterからテキスト回答を取得できませんでした。" };
}

function systemInstruction() {
  return "日本語のみで回答してください。挨拶、自己紹介、Markdown、表は使わず、質問に直接答えてください。結論から書き、具体例を含め、途中で終わらせないでください。";
}

function buildPrompt(question: string, provider: ProviderConfig) {
  return [providerPrompt(provider), "", "質問:", question].join("\n");
}

function providerPrompt(provider: ProviderConfig) {
  if (provider.id === "gemini-free") {
    return [
      "役割: 整理初心者向け解説担当。",
      "わかりやすさと読みやすさを最優先し、専門用語を減らしてください。",
      "自己紹介、挨拶、キャラ口調は禁止です。",
      "通常質問は250〜450文字、開発専門質問は400〜900文字を目安にしてください。",
      "必ず質問に直接答え、具体例を1つ以上入れてください。",
    ].join("\n");
  }
  if (provider.id === "openrouter-free") {
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

function resolveThirdFreeModel(provider: ProviderConfig) {
  const configured = process.env.OPENROUTER_QWEN_MODEL?.trim();
  return configured && configured !== "qwen/qwen3-14b:free" ? configured : provider.model;
}

function openRouterModelCandidates(provider: ProviderConfig) {
  return uniqueModels([process.env.OPENROUTER_FREE_MODEL, provider.model, "openai/gpt-oss-20b:free", "meta-llama/llama-3.2-3b-instruct:free"]);
}

function thirdFreeModelCandidates(provider: ProviderConfig) {
  return uniqueModels([
    resolveThirdFreeModel(provider),
    "openai/gpt-oss-20b:free",
    "meta-llama/llama-3.2-3b-instruct:free",
    "z-ai/glm-4.5-air:free",
    "google/gemma-4-26b-a4b-it:free",
  ]);
}

function uniqueModels(models: Array<string | undefined>) {
  return Array.from(new Set(models.map((model) => model?.trim()).filter((model): model is string => Boolean(model))));
}

function toAnswer(result: ProviderCallResult, index: number): AiAnswer {
  const hasError = Boolean(result.error);
  const content = cleanAnswerText(result.content ?? "");
  const summary = hasError ? "このAIは現在一時的に利用できません。他のAIの回答をご確認ください。" : firstParagraph(content);
  const score = hasError ? 0 : scoreAnswer(content);
  return {
    id: result.provider.id,
    name: result.provider.name,
    model: result.provider.model,
    role: result.provider.role,
    status: hasError ? "error" : "complete",
    confidence: score,
    summary,
    bullets: hasError ? [result.error ?? publicProviderError("simple")] : extractBullets(content, summary),
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
      recommendation: "中継サーバーのAPIキー設定を確認してください。",
      reason: "簡単モードはサーバー側のAPIキーでAIへ問い合わせますが、有効な回答を取得できませんでした。",
      alternatives: ["GEMINI_API_KEY を設定する", "OPENROUTER_API_KEY を設定する", "詳細モードでユーザーAPIキーを使う"],
      cautions: failed.map((answer) => `${answer.name}: ${answer.errorMessage ?? publicProviderError("simple")}`),
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
    cautions: [...failed.map((answer) => `${answer.name}: 一時的に利用できなかったため不採用`), ...ranked.slice(1).map((answer) => `${answer.name}: ${nonAdoptionReason(answer, best)}`)].slice(0, 4),
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

async function sanitizeProviderError(response: Response, mode: "simple" | "advanced") {
  const text = await response.text();
  return publicProviderError(mode, text, response.status);
}

function publicProviderError(mode: "simple" | "advanced", raw = "", status?: number) {
  const detail = extractErrorDetail(raw);
  if (status === 401 || /missing authentication|unauthorized|401/i.test(raw)) {
    return mode === "simple"
      ? "このAIは現在利用できません。中継サーバー側の認証設定が必要です。"
      : "このAIは現在利用できません。APIキーが未入力、または認証情報が正しくない可能性があります。";
  }

  if (detail) {
    return `このAIは現在一時的に利用できません。他のAIの回答をご確認ください。`;
  }

  return mode === "simple"
    ? "このAIは現在一時的に利用できません。他のAIの回答をご確認ください。"
    : "このAIは現在利用できません。APIキー設定または認証設定を確認してください。";
}

function extractErrorDetail(raw: string) {
  if (!raw.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; code?: string | number }; message?: string; code?: string | number };
    return parsed.error?.message || parsed.message || String(parsed.error?.code || parsed.code || "");
  } catch {
    return raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  }
}
