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
  const answers = results.map((result) => toAnswer(result));

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
    throw new Error("APKの簡単モードでは `NEXT_PUBLIC_SIMPLE_RELAY_URL` に公開中の中継サーバーURLを設定してください。");
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
  if (provider.id === "grok") return callGrok(provider, category, question, key);
  if (provider.id === "openrouter") return callOpenRouter(provider, category, question, key);
  if (provider.id === "deepseek") return callDeepSeek(provider, category, question, key);

  return { provider, error: `${provider.name}: ブラウザからの呼び出しは未対応です。` };
}

async function callOpenAI(provider: ProviderConfig, category: ConsultationCategory, question: string, apiKey: string): Promise<ProviderCallResult> {
  const model = provider.model || "gpt-4.1-mini";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: systemInstruction(),
      input: buildPrompt(question, provider, category),
      temperature: 0.4,
      max_output_tokens: 900,
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { output_text?: string; model?: string };
  const content = data.output_text?.trim();
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "OpenAIから本文を取得できませんでした。" };
}

async function callAnthropic(provider: ProviderConfig, category: ConsultationCategory, question: string, apiKey: string): Promise<ProviderCallResult> {
  const model = provider.model || "claude-sonnet-4-5";
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 900,
      system: systemInstruction(),
      messages: [{ role: "user", content: buildPrompt(question, provider, category) }],
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { content?: Array<{ text?: string }>; model?: string };
  const content = data.content?.map((item) => item.text ?? "").join("").trim();
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "Claudeから本文を取得できませんでした。" };
}

async function callGemini(provider: ProviderConfig, category: ConsultationCategory, question: string, apiKey: string): Promise<ProviderCallResult> {
  const model = provider.model || process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  const first = await callGeminiModel(provider, category, question, apiKey, model, false);
  if (first.content && scoreAnswer(cleanAnswerText(first.content)) >= 65) return first;
  if (first.content) return callGeminiModel(provider, category, question, apiKey, model, true);
  return first;
}

async function callGeminiModel(
  provider: ProviderConfig,
  category: ConsultationCategory,
  question: string,
  apiKey: string,
  model: string,
  retry: boolean,
): Promise<ProviderCallResult> {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${systemInstruction()}\n\n${retry ? "前回の回答が短すぎるか未完成でした。挨拶なしで、結論から、具体例を含めて最後まで回答してください。\n\n" : ""}${buildPrompt(question, provider, category)}` }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 900 },
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const content = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  return content ? { provider: { ...provider, model }, content } : { provider, error: "Geminiから本文を取得できませんでした。" };
}

async function callOpenRouter(provider: ProviderConfig, category: ConsultationCategory, question: string, apiKey: string): Promise<ProviderCallResult> {
  const model = provider.model || "openrouter/auto";
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
        { role: "user", content: buildPrompt(question, provider, category) },
      ],
      temperature: 0.4,
      max_tokens: 900,
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (content && englishRatio(content) > 0.18) return { provider: { ...provider, model }, error: "英語混入が多いため再取得が必要です。" };
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "OpenRouterから本文を取得できませんでした。" };
}

async function callGrok(provider: ProviderConfig, category: ConsultationCategory, question: string, apiKey: string): Promise<ProviderCallResult> {
  const grokProvider = provider.id === "grok" ? { ...provider, model: provider.model || "x-ai/grok-4.3" } : provider;
  return callOpenRouter(grokProvider, category, question, apiKey);
}

async function callDeepSeek(provider: ProviderConfig, category: ConsultationCategory, question: string, apiKey: string): Promise<ProviderCallResult> {
  const model = provider.model || "deepseek-chat";
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
        { role: "user", content: buildPrompt(question, provider, category) },
      ],
      temperature: 0.4,
      max_tokens: 900,
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (content && englishRatio(content) > 0.18) return { provider: { ...provider, model }, error: "英語混入が多いため再取得が必要です。" };
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "DeepSeekから本文を取得できませんでした。" };
}

function systemInstruction() {
  return [
    "日本語のみで回答してください。",
    "挨拶、自己紹介、キャラ口調、Markdown、表は不要です。",
    "結論から書き、途中で終わらず最後まで回答してください。",
    "他のAIと同じ内容をなぞらず、このAIならではの視点を出してください。",
    "短く無難にまとめるより、実用性と完成度を優先してください。",
  ].join("\n");
}

function buildPrompt(question: string, provider: ProviderConfig, category: ConsultationCategory) {
  return [providerPrompt(provider, category), "", "質問:", question].join("\n");
}

function providerPrompt(provider: ProviderConfig, category: ConsultationCategory) {
  const categoryHint =
    category === "development"
      ? "開発・実装の相談です。コード設計や手順が役立ちます。"
      : category === "health"
        ? "健康・食事の相談です。一般情報として整理し、診断は避けてください。"
        : category === "business"
          ? "業務・意思決定の相談です。実務で使える判断材料を重視してください。"
          : category === "learning"
            ? "学習の相談です。理解の順番と学びやすさを重視してください。"
            : "生活の相談です。実用性と分かりやすさを重視してください。";

  if (provider.id === "openai") {
    return [
      "役割: 実装・整理・推論補助",
      categoryHint,
      "得意分野: ロジカル整理 / 実装方法 / 推論 / 問題分解 / 実用的提案",
      "指示: 結論から書く。実用性重視。開発質問ではコード設計を重視する。長文OK。実際に使える内容を優先する。",
      "禁止: 無駄な前置き / 自己紹介 / キャラ口調 / 他AIの繰り返し",
      "文字数目安: 通常 350〜700文字 / 開発質問 700〜1200文字",
      "注意: 他のAIと同じ内容を繰り返さず、このAIならではの実装・整理・推論を出す。",
    ].join("\n");
  }
  if (provider.id === "anthropic") {
    return [
      "役割: 設計・文章・注意点の補助",
      categoryHint,
      "得意分野: UX / 設計思想 / 読みやすい説明 / リスク整理 / 長文整理",
      "指示: ユーザー視点を重視する。設計の欠点も指摘する。読みやすさを意識し、抽象と具体を両立する。",
      "禁止: 曖昧な結論 / 過剰な遠回し表現 / 他AIの繰り返し",
      "文字数目安: 400〜800文字",
      "注意: 結論をぼかさず、設計判断として使える内容にする。",
    ].join("\n");
  }
  if (provider.id === "grok") {
    return [
      "役割: 反対意見・別視点・鋭い指摘担当",
      categoryHint,
      "得意分野: 反論 / 別視点 / リスク指摘 / 前提へのツッコミ / 代替案",
      "指示: 他AIに安易に同意しない。前提の弱さや見落としを指摘する。楽観的な結論は疑い、別解を出す。鋭さを優先する。",
      "文字数目安: 300〜700文字",
      "禁止: 単純な同意 / 無意味な褒め / 内容の薄い補足 / 他AIの焼き直し",
      "注意: 指摘だけで終わらず、判断材料になる代替案も必ず入れる。",
    ].join("\n");
  }
  if (provider.id === "deepseek") {
    return [
      "役割: 低コスト推論・開発相談・別解提示",
      categoryHint,
      "得意分野: 別アプローチ / コスト意識 / 実験的提案 / 開発相談 / 実装アイデア",
      "指示: 他AIと違う視点を出す。コスパ視点を含める。開発現実性を意識し、代替案も提示する。",
      "禁止: 他AIの繰り返し / 内容の薄い同意",
      "注意: 実装案は安さだけでなく、現実に動くかまで含めて評価する。",
    ].join("\n");
  }
  if (provider.id === "openrouter") {
    return [
      "役割: 補足・批判・比較・追加視点",
      categoryHint,
      "得意分野: 別モデル視点 / 批判 / リスク / 補足知識 / 比較",
      "指示: 他AIの弱点も指摘する。別視点を必ず追加する。補足情報を出し、リスクも説明する。",
      "日本語ルール: 自然な日本語のみ。英語禁止。翻訳調禁止。Markdown禁止。",
      "注意: 反対意見や注意点を曖昧にせず、判断材料として使える形で書く。",
    ].join("\n");
  }
  if (provider.id === "qwen-free") {
    return [
      "役割: 実装・整理・推論補助",
      categoryHint,
      "得意分野: ロジカル整理 / 実装方法 / 推論 / 問題分解 / 実用的提案",
      "指示: 結論から書く。開発質問ではコード設計を重視する。長文でもよい。実際に使える内容を優先する。",
      "禁止: 無意味な前置き / 自己紹介 / キャラ口調 / Markdown",
      "注意: 他AIと内容が被る場合は、実装の具体化や整理に寄せて差別化する。",
    ].join("\n");
  }
  return [
    "役割: 補足・比較・追加視点",
    categoryHint,
    "指示: 他AIと違う視点を出してください。",
  ].join("\n");
}

function toAnswer(result: ProviderCallResult): AiAnswer {
  const hasError = Boolean(result.error);
  const content = cleanAnswerText(result.content ?? "");
  const summary = hasError ? "このAIは今回のモードでは利用できませんでした。APIキーや接続設定を確認してください。" : firstParagraph(content);
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
      ? "これは一般的な情報です。診断や治療ではありません。症状が強い場合や不安がある場合は医療機関に相談してください。"
      : undefined;

  if (completed.length === 0) {
    return {
      recommendation: "有効なAI回答が得られませんでした。APIキーと接続設定を確認して、もう一度実行してください。",
      reason: "詳細モードでは、各AIに設定されたAPIキーが必要です。回答が取得できないと合議も作れません。",
      alternatives: ["有効なAPIキーを設定する", "使うAIを1つ以上有効化する", "接続先の制限やエラー内容を確認する"],
      cautions: failed.map((answer) => `${answer.name}: ${answer.errorMessage ?? publicProviderError("advanced")}`),
      safetyNote,
    };
  }

  const ranked = [...completed].sort((a, b) => b.confidence - a.confidence);
  const best = ranked[0];
  const supplements = ranked.slice(1).map((answer) => answer.summary).slice(0, 2);
  const reasons = adoptionReasonLabels(best, ranked);

  return {
    recommendation: buildFinalRecommendation(best, supplements, reasons, failed),
    reason: reasons.join(" / "),
    alternatives: buildPeerReviews(ranked),
    cautions: [
      ...failed.map((answer) => `${answer.name}: 取得失敗または制限により採用できませんでした`),
      ...ranked.slice(1).map((answer) => `${answer.name}: ${nonAdoptionReason(answer, best)}`),
    ].slice(0, 4),
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
  const sentenceCount = (text.match(/[。！？]/g) ?? []).length;
  const hasExample = /(?:例|たとえば|例えば|具体例|たとえると)/.test(text);
  const hasConclusion = /(?:結論|要するに|おすすめ|結局)/.test(text);
  const hasStructure = /\n/.test(text) || /\d+\./.test(text);
  const englishRatioValue = englishRatio(text);
  const incomplete = /(?:説明します|以下|途中|...)\s*$/.test(text) || sentenceCount < 2;

  let score = 52;
  if (length >= 180) score += 10;
  if (length >= 360) score += 8;
  if (length > 900) score -= 4;
  if (sentenceCount >= 3) score += 6;
  if (hasExample) score += 8;
  if (hasConclusion) score += 6;
  if (hasStructure) score += 4;
  if (englishRatioValue > 0.18) score -= 14;
  if (incomplete) score -= 20;
  return Math.max(45, Math.min(96, score));
}

function englishRatio(text: string) {
  return (text.match(/[A-Za-z]/g)?.length ?? 0) / Math.max(1, text.length);
}

function buildFinalRecommendation(best: AiAnswer, supplements: string[], reasons: string[], failed: AiAnswer[]) {
  const base = best.summary.replace(/\s+/g, " ");
  const lead = reasons.length ? `最終結論: ${reasons.slice(0, 2).join(" / ")}。` : "最終結論。";
  const support = supplements.length ? ` 補足: ${supplements.join(" / ")}` : "";
  const caution = failed.length ? " 一部の候補は取得できませんでした。" : "";
  return trimToLength(`${lead}${base}${support}${caution}`, 400);
}

function trimToLength(text: string, max: number) {
  if (text.length <= max) return text;
  const sliced = text.slice(0, max);
  const lastPeriod = sliced.lastIndexOf("。");
  return `${(lastPeriod > 120 ? sliced.slice(0, lastPeriod + 1) : sliced).trim()}…`;
}

function adoptionReasonLabels(best: AiAnswer, ranked: AiAnswer[]) {
  const reasons = ["質問への適合性が高い", "内容の密度が高い"];
  if (best.confidence >= 82) reasons.push("完成度が高い");
  if (ranked.length > 1) reasons.push("他AIの有用な補足と整合した");
  reasons.push("単純な並列ではなく統合結論に向く");
  return reasons.slice(0, 4);
}

function buildPeerReviews(ranked: AiAnswer[]) {
  return ranked.slice(0, 3).map((answer, index) => {
    const base =
      answer.name === "Grok"
        ? "反対視点と鋭い指摘が強く、結論の偏りを補正しやすい"
        : answer.name === "GPT OSS Free"
          ? "実装寄りで有用だが、結論の磨き込みは別途必要"
          : answer.name === "OpenRouter"
            ? "補足とリスク確認が強く、反対意見の役割に向く"
            : answer.name === "Claude"
              ? "設計と文章の整理が強く、UXや注意点の把握に向く"
              : answer.name === "DeepSeek"
                ? "別解とコスト感が有用だが、採用前の検証が必要"
                : "ロジカルで実装に強く、統合の軸に向く";
    return `${answer.name}: ${base}`;
  });
}

function nonAdoptionReason(answer: AiAnswer, best: AiAnswer) {
  if (answer.confidence + 8 < best.confidence) return "最終結論の軸にするには情報密度が少し足りませんでした";
  return "補足としては有用ですが、主役にするほどではありませんでした";
}

function parseApiResponse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("中継サーバーから正しいJSONを受け取れませんでした。時間をおいて再試行してください。");
  }
}

async function sanitizeProviderError(response: Response, mode: "simple" | "advanced") {
  const text = await response.text();
  return publicProviderError(mode, text, response.status);
}

function publicProviderError(mode: "simple" | "advanced", raw = "", status?: number) {
  const detail = extractErrorDetail(raw);
  if (status === 401 || /missing authentication|unauthorized|401|missing api key/i.test(raw)) {
    return mode === "simple"
      ? "このAIは現在使用できません。中継サーバー側の設定を確認してください。"
      : "このAIは現在使用できません。APIキーが未入力か、認証情報が正しくありません。";
  }

  if (detail) {
    return mode === "simple"
      ? "このAIは現在一時的に利用できません。別のAIの回答を確認してください。"
      : "このAIは現在一時的に利用できません。APIキーや接続設定を確認してください。";
  }

  return mode === "simple"
    ? "このAIは現在一時的に利用できません。別のAIの回答を確認してください。"
    : "このAIは現在一時的に利用できません。APIキーや接続設定を確認してください。";
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

