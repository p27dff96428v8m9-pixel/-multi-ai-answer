import { NextRequest, NextResponse } from "next/server";
import { AiAnswer, AnalysisResult, ConsultationCategory, ProviderConfig, UsageMode, builtInProviders, categoryLabels } from "@/lib/dummy-ai";
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

const categoryInstruction: Record<ConsultationCategory, string> = {
  development: "ソフトウェア設計、実装、安全性、保守性、現実的な進め方の観点で答えてください。",
  life: "日常で実行しやすく、負担が少ない行動に分けて答えてください。",
  health: "一般的な健康・食事情報として答えてください。診断や治療判断は避け、必要なら専門家への相談を促してください。",
  business: "事業性、検証方法、コスト、収益化、リスクの観点で答えてください。",
  learning: "わかりやすい説明、学習計画、例、復習方法を含めて答えてください。",
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
    const results = await Promise.all(providers.map((provider) => callBuiltInProvider(provider, category, question)));
    const answers = results.map((result, index) => toAnswer(result, category, index));

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

async function callBuiltInProvider(provider: ProviderConfig, category: ConsultationCategory, question: string): Promise<ProviderCallResult> {
  if (provider.id === "gemini-free") return callGemini(provider, category, question);
  if (provider.id === "openrouter-free" || provider.id === "qwen-free") return callOpenRouter(provider, category, question);
  return { provider, error: `${provider.name} は簡単モードの中継サーバーで未対応です。` };
}

async function callGemini(provider: ProviderConfig, category: ConsultationCategory, question: string): Promise<ProviderCallResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { provider, error: "中継サーバーに GEMINI_API_KEY が設定されていません。" };

  const model = process.env.GEMINI_MODEL || provider.model;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${systemInstruction()}\n\n${buildPrompt(category, question, provider.name)}` }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 700 },
    }),
  });

  if (!response.ok) return { provider, error: await response.text() };
  const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const content = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  return content ? { provider: { ...provider, model }, content } : { provider: { ...provider, model }, error: "Geminiからテキスト回答を取得できませんでした。" };
}

async function callOpenRouter(provider: ProviderConfig, category: ConsultationCategory, question: string): Promise<ProviderCallResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { provider, error: "中継サーバーに OPENROUTER_API_KEY が設定されていません。" };

  const model = provider.id === "qwen-free" ? process.env.OPENROUTER_QWEN_MODEL || provider.model : process.env.OPENROUTER_FREE_MODEL || provider.model;
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
        { role: "user", content: buildPrompt(category, question, provider.name) },
      ],
      temperature: 0.4,
      max_tokens: 700,
    }),
  });

  if (!response.ok) return { provider, error: await response.text() };
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  const content = data.choices?.[0]?.message?.content?.trim();
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider: { ...provider, model }, error: "OpenRouterからテキスト回答を取得できませんでした。" };
}

function systemInstruction() {
  return "日本語で簡潔に答えてください。推奨案、理由、代替案、注意点を明確にしてください。";
}

function buildPrompt(category: ConsultationCategory, question: string, providerName: string) {
  return [
    `カテゴリ: ${categoryLabels[category]}`,
    `担当AI: ${providerName}`,
    categoryInstruction[category],
    "次の形式を意識してください: 1. 要約 2. 推奨案 3. 理由 4. 注意点",
    `質問: ${question}`,
  ].join("\n");
}

function toAnswer(result: ProviderCallResult, category: ConsultationCategory, index: number): AiAnswer {
  const hasError = Boolean(result.error);
  const content = result.content ?? "";
  return {
    id: result.provider.id,
    name: result.provider.name,
    model: result.provider.model,
    role: result.provider.role || categoryInstruction[category],
    status: hasError ? "error" : "complete",
    confidence: hasError ? 0 : Math.max(72, 88 - index * 4),
    summary: hasError ? "このAIから回答を取得できませんでした。" : firstParagraph(content),
    bullets: hasError ? [result.error ?? "不明なエラー"] : extractBullets(content),
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
      cautions: failed.map((answer) => `${answer.name}: ${answer.errorMessage ?? "取得失敗"}`),
      safetyNote,
    };
  }

  return {
    recommendation: completed[0].summary,
    reason: `簡単モードで ${completed.length} 件の回答を取得しました。質問: ${question}`,
    alternatives: completed.slice(1).map((answer) => `${answer.name}: ${answer.summary}`).slice(0, 3),
    cautions: failed.map((answer) => `${answer.name}: ${answer.errorMessage ?? "取得失敗"}`).slice(0, 4),
    safetyNote,
  };
}

function firstParagraph(text: string) {
  return text.split(/\n{2,}/).find(Boolean)?.replace(/^[-*\d.\s]+/, "").trim() || text.slice(0, 180);
}

function extractBullets(text: string) {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean);
  return lines.slice(0, 4).length ? lines.slice(0, 4) : [text.slice(0, 220)];
}
