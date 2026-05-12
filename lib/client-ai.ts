import {
  AiAnswer,
  AnalysisResult,
  ConsultationCategory,
  ProviderConfig,
  UsageMode,
  categoryLabels,
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

const categoryInstruction: Record<ConsultationCategory, string> = {
  development: "ソフトウェア設計、実装、安全性、保守性、現実的な進め方の観点で答えてください。",
  life: "日常で実行しやすく、負担が少ない行動に分けて答えてください。",
  health: "一般的な健康・食事情報として答えてください。診断や治療判断は避け、必要なら専門家への相談を促してください。",
  business: "事業性、検証方法、コスト、収益化、リスクの観点で答えてください。",
  learning: "わかりやすい説明、学習計画、例、復習方法を含めて答えてください。",
};

export async function askAdvancedProviders(input: ClientAskInput): Promise<AnalysisResult> {
  const activeProviders = input.providers.filter((provider) => provider.enabled && provider.origin === "custom");
  const results = await Promise.all(
    activeProviders.map((provider) => callProvider(provider, input.category, input.question, input.customKeys[provider.id] ?? "")),
  );
  const answers = results.map((result, index) => toAnswer(result, input.category, index));

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
  if (!response.ok) throw new Error(data.error ?? "簡単モードの中継リクエストに失敗しました。");
  return data as AnalysisResult;
}

async function callProvider(provider: ProviderConfig, category: ConsultationCategory, question: string, apiKey: string): Promise<ProviderCallResult> {
  const key = apiKey.trim();
  if (!key) return { provider, error: `${provider.name}: APIキーが未入力です。` };

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
      input: buildPrompt(category, question, provider.name),
      temperature: 0.4,
      max_output_tokens: 700,
    }),
  });
  if (!response.ok) return { provider, error: await response.text() };
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
      messages: [{ role: "user", content: buildPrompt(category, question, provider.name) }],
    }),
  });
  if (!response.ok) return { provider, error: await response.text() };
  const data = (await response.json()) as { content?: Array<{ text?: string }>; model?: string };
  const content = data.content?.map((item) => item.text ?? "").join("").trim();
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "Claudeからテキスト回答を取得できませんでした。" };
}

async function callGemini(provider: ProviderConfig, category: ConsultationCategory, question: string, apiKey: string): Promise<ProviderCallResult> {
  const model = "gemini-2.5-flash";
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
        { role: "user", content: buildPrompt(category, question, provider.name) },
      ],
      temperature: 0.4,
      max_tokens: 700,
    }),
  });
  if (!response.ok) return { provider, error: await response.text() };
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  const content = data.choices?.[0]?.message?.content?.trim();
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
        { role: "user", content: buildPrompt(category, question, provider.name) },
      ],
      temperature: 0.4,
      max_tokens: 700,
    }),
  });
  if (!response.ok) return { provider, error: await response.text() };
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  const content = data.choices?.[0]?.message?.content?.trim();
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "DeepSeekからテキスト回答を取得できませんでした。" };
}

function systemInstruction() {
  return "日本語で、簡潔かつ実用的に答えてください。推奨案、理由、代替案、注意点を明確にしてください。";
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
      recommendation: "有効なAPIキーを設定してから再実行してください。",
      reason: "詳細モードでは、入力されたユーザーAPIキーを使って各AIへ直接問い合わせます。",
      alternatives: ["別のAIキーを使う", "簡単モードで中継サーバーを使う", "キーを保存せず今回だけ入力する"],
      cautions: failed.map((answer) => `${answer.name}: ${answer.errorMessage ?? "取得失敗"}`),
      safetyNote,
    };
  }

  return {
    recommendation: completed[0].summary,
    reason: `${completed.length}件のAI回答を取得しました。質問: ${question}`,
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

function parseApiResponse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    throw new Error(`中継サーバーからJSONではない応答が返りました。${preview ? ` 内容: ${preview}` : ""}`);
  }
}
