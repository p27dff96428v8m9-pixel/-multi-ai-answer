import {
  AiAnswer,
  AnalysisResult,
  ConsultationCategory,
  ProviderConfig,
  UsageMode,
} from "@/lib/dummy-ai";
import { attachSourceContextToQuestion, resolveSourceContext } from "@/lib/source-context";

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
  const relay = getAdvancedRelayUrl();
  if (relay) {
    const response = await fetch(`${relay}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const text = await response.text();
    const data = parseApiResponse(text);
    if (!response.ok) throw new Error(publicProviderError("advanced", data.error ?? text, response.status));
    return normalizeAnalysisResult(data as AnalysisResult);
  }

  const sourceContext = await resolveSourceContext(input.question);
  const question = attachSourceContextToQuestion(input.question, sourceContext);
  const primaryExecutableAgents = input.providers.filter(
    (provider) => provider.enabled && provider.origin === "custom" && Boolean(input.customKeys[provider.id]?.trim()),
  );

  if (primaryExecutableAgents.length === 0) {
    throw new Error("参加可能なAIがありません。詳細モードでは、APIキー入力済みの主AIが1つ以上必要です。AIをONにしてAPIキーを入力してください。");
  }

  const results = await Promise.all(
    primaryExecutableAgents.map((provider) => callProvider(provider, input.category, question, input.customKeys[provider.id] ?? "")),
  );
  const mainAnswers = results.map((result) => toAnswer(result));
  const helperAnswers = await buildHelperAnswers({ ...input, question }, primaryExecutableAgents.length);
  const answers = [...mainAnswers, ...helperAnswers];

  return normalizeAnalysisResult({
    question,
    category: input.category,
    mode: input.mode,
    answers,
    conclusion: await buildConclusion(question, input.category, answers, input.customKeys),
    generatedAt: new Date().toISOString(),
  });
}

async function buildHelperAnswers(input: ClientAskInput, primaryCount: number) {
  if (primaryCount === 0 || primaryCount >= 3) return [];
  const selectedHelpers = input.providers.filter((provider) => provider.enabled && provider.origin === "built-in");
  const helperProviders = selectedHelpers.slice(0, 3);
  if (helperProviders.length === 0) return [];

  try {
    const helperResult = await askSimpleRelay({
      question: input.question,
      category: input.category,
      mode: "simple",
      providers: helperProviders,
    });
    return helperResult.answers
      .filter((answer) => answer.status === "complete")
      .map(markHelperAnswer);
  } catch {
    return [];
  }
}

function markHelperAnswer(answer: AiAnswer): AiAnswer {
  const helperText = answer.fullText ? trimToLength(answer.fullText, 900) : undefined;
  return {
    ...answer,
    isHelper: true,
    confidence: answer.confidence,
    summary: trimToLength(answer.summary, 700),
    bullets: answer.bullets.map((bullet) => trimToLength(bullet, 420)).slice(0, 4),
    fullText: helperText,
    role: `${answer.role} / 参加AI`,
  };
}

export function getSimpleRelayUrl() {
  const raw = process.env.NEXT_PUBLIC_SIMPLE_RELAY_URL?.trim();
  return raw ? raw.replace(/\/$/, "") : "";
}

function getAdvancedRelayUrl() {
  if (typeof window === "undefined") return "";
  const hasCapacitorBridge = Boolean((globalThis as { Capacitor?: unknown }).Capacitor);
  const protocol = globalThis.location?.protocol ?? "";
  if (!hasCapacitorBridge && !protocol.startsWith("capacitor")) return "";
  return getSimpleRelayUrl();
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
  return normalizeAnalysisResult(data as AnalysisResult);
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
  if (first.content && !looksTruncated(first.content) && scoreAnswer(cleanAnswerText(first.content)) >= 65) return first;
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
      contents: [{ parts: [{ text: `${systemInstruction()}\n\n${retry ? "前回の回答が短すぎるか途中で切れました。最後の文は必ず句点「。」で終え、結論、理由、具体例、注意点まで完結させてください。\n\n" : ""}${buildPrompt(question, provider, category)}` }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 2200 },
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const content = finalizeSentence(data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "");
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
  const model = provider.model || "deepseek-v4-flash";
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
    "開発・コードの質問でない限り、開発者向けの実装説明やアプリ開発目線の話はしないでください。",
    "URLや動画について回答する場合、取得済みのタイトル、概要欄、字幕、メタ情報だけを根拠にしてください。",
    "動画を見たふり、取得できない内容の推測補完、断定は禁止です。",
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
        : category === "money"
          ? "お金・家計・投資の相談です。一般情報として整理し、断定的な金融助言は避けてください。"
          : category === "legal"
            ? "法律・契約・権利の相談です。一般情報として整理し、法的判断の断定や弁護士業務に当たる助言は避けてください。"
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
    fullText: hasError ? undefined : content,
    costLabel: result.provider.costLabel,
    origin: result.provider.origin,
    errorMessage: result.error,
  };
}

async function buildConclusion(
  question: string,
  category: ConsultationCategory,
  answers: AiAnswer[],
  customKeys: Record<string, string>,
): Promise<AnalysisResult["conclusion"]> {
  const fallback = buildSystemConclusion(question, category, answers);
  const chaired = await buildChairConclusion(question, category, answers, fallback, customKeys);
  return chaired ?? fallback;
}

function buildSystemConclusion(question: string, category: ConsultationCategory, answers: AiAnswer[]): AnalysisResult["conclusion"] {
  const completed = answers.filter((answer) => answer.status === "complete");
  const completedMain = completed.filter((answer) => !answer.isHelper);
  const completedHelpers = completed.filter((answer) => answer.isHelper);
  const failed = answers.filter((answer) => answer.status === "error");
  const safetyNote =
    category === "health"
      ? "これは一般的な情報です。診断や治療ではありません。症状が強い場合や不安がある場合は医療機関に相談してください。"
      : undefined;

  if (completedMain.length === 0) {
    return {
      recommendation: "有効なAI回答が得られませんでした。APIキーと接続設定を確認して、もう一度実行してください。",
      reason: "詳細モードでは、各AIに設定されたAPIキーが必要です。回答が取得できないと合議も作れません。",
      alternatives: ["有効なAPIキーを設定する", "使うAIを1つ以上有効化する", "接続先の制限やエラー内容を確認する"],
      cautions: failed.map((answer) => `${answer.name}: ${answer.errorMessage ?? publicProviderError("advanced")}`),
      safetyNote,
    };
  }

  const ranked = [...completedMain, ...completedHelpers].sort((a, b) => b.confidence - a.confidence);
  const best = ranked[0];
  const supplements = ranked.slice(1).map((answer) => answer.summary).slice(0, 2);
  const reasons = adoptionReasonLabels(best, ranked);

  return {
    recommendation: buildFinalRecommendation(question, best, supplements, reasons, answers),
    reason: reasons.join(" / "),
    alternatives: buildPeerReviews(ranked),
    cautions: ranked.slice(1).map((answer) => `${answer.name}: ${nonAdoptionReason(answer, best)}`).slice(0, 4),
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
  return finalizeSentence(text
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\|/g, " ")
    .trim());
}

function looksTruncated(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.length < 260) return true;
  return !/[。！？.!?）」』]$/.test(trimmed);
}

function finalizeSentence(text: string) {
  const trimmed = text.trim();
  if (!trimmed || /[。！？.!?）」』]$/.test(trimmed)) return trimmed;
  const lastStop = Math.max(trimmed.lastIndexOf("。"), trimmed.lastIndexOf("！"), trimmed.lastIndexOf("？"));
  if (lastStop >= Math.floor(trimmed.length * 0.55)) return trimmed.slice(0, lastStop + 1);
  return `${trimmed}。`;
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

function buildFinalRecommendation(question: string, best: AiAnswer, supplements: string[], reasons: string[], answers: AiAnswer[]) {
  const base = (best.fullText || best.summary).replace(/\s+/g, " ");
  const lead = reasons.length ? `最終結論: ${reasons.slice(0, 2).join(" / ")}。` : "最終結論。";
  const support = supplements.length ? ` 補足: ${supplements.join(" / ")}` : "";
  return repairRecommendation(question, trimToLength(`${lead}${base}${support}`, 700), answers);
}

async function buildChairConclusion(
  question: string,
  category: ConsultationCategory,
  answers: AiAnswer[],
  fallback: AnalysisResult["conclusion"],
  customKeys: Record<string, string>,
): Promise<AnalysisResult["conclusion"] | null> {
  const candidates = answers
    .filter((answer) => answer.status === "complete" && answer.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);

  for (const candidate of candidates) {
    try {
      const provider = answerToProvider(candidate);
      const prompt = buildChairPrompt(question, category, answers, fallback, candidate);
      const apiKey = customKeys[candidate.id]?.trim() ?? "";
      const result = apiKey ? await callChairProvider(provider, prompt, apiKey) : { provider, content: "" };
      const recommendation = cleanAnswerText(result.content ?? "");
      if (recommendation.length >= 80) {
        return {
          ...fallback,
          recommendation: repairRecommendation(question, trimToLength(recommendation, 900), answers),
          reason: `議長AI（${candidate.name}）が整理専用として全AIの回答を公平に再統合しました。`,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

function answerToProvider(answer: AiAnswer): ProviderConfig {
  return {
    id: answer.id as ProviderConfig["id"],
    name: answer.name,
    model: answer.model,
    role: answer.role,
    costLabel: answer.costLabel,
    origin: answer.origin,
    enabled: true,
    hasApiKey: true,
  };
}

async function callChairProvider(provider: ProviderConfig, prompt: string, apiKey: string): Promise<ProviderCallResult> {
  if (provider.id === "openai") return callOpenAIChair(provider, prompt, apiKey);
  if (provider.id === "anthropic") return callAnthropicChair(provider, prompt, apiKey);
  if (provider.id === "grok") return callGrokChair(provider, prompt, apiKey);
  if (provider.id === "openrouter") return callOpenRouterChair(provider, prompt, apiKey);
  if (provider.id === "deepseek") return callDeepSeekChair(provider, prompt, apiKey);
  return { provider, error: `${provider.name}: 議長AIとしての呼び出しは未対応です。` };
}

async function callOpenAIChair(provider: ProviderConfig, prompt: string, apiKey: string): Promise<ProviderCallResult> {
  const model = provider.model || "gpt-4.1-mini";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: chairSystemInstruction(),
      input: prompt,
      temperature: 0.2,
      max_output_tokens: 1000,
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { output_text?: string; model?: string };
  const content = data.output_text?.trim();
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "議長AIから本文を取得できませんでした。" };
}

async function callAnthropicChair(provider: ProviderConfig, prompt: string, apiKey: string): Promise<ProviderCallResult> {
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
      max_tokens: 1000,
      system: chairSystemInstruction(),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { content?: Array<{ text?: string }>; model?: string };
  const content = data.content?.map((item) => item.text ?? "").join("").trim();
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "議長AIから本文を取得できませんでした。" };
}

async function callOpenRouterChair(provider: ProviderConfig, prompt: string, apiKey: string): Promise<ProviderCallResult> {
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
        { role: "system", content: chairSystemInstruction() },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 1000,
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (content && englishRatio(content) > 0.18) return { provider: { ...provider, model: data.model || model }, error: "英語混入が多いため議長AIとして採用できません。" };
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "議長AIから本文を取得できませんでした。" };
}

async function callGrokChair(provider: ProviderConfig, prompt: string, apiKey: string): Promise<ProviderCallResult> {
  const grokProvider = { ...provider, model: provider.model || "x-ai/grok-4.3" };
  return callOpenRouterChair(grokProvider, prompt, apiKey);
}

async function callDeepSeekChair(provider: ProviderConfig, prompt: string, apiKey: string): Promise<ProviderCallResult> {
  const model = provider.model || "deepseek-v4-flash";
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: chairSystemInstruction() },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 1000,
    }),
  });
  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "advanced") };
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (content && englishRatio(content) > 0.18) return { provider: { ...provider, model }, error: "英語混入が多いため議長AIとして採用できません。" };
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "議長AIから本文を取得できませんでした。" };
}

function chairSystemInstruction() {
  return [
    "あなたは複数AI会議の議長AIです。",
    "日本語のみで、挨拶や自己紹介なしで回答してください。",
    "あなた自身の元回答を特別扱いせず、全AIの回答を公平に比較してください。",
    "自分の考えを強く押し出さず、元回答に含まれる根拠と有用な補足だけを統合してください。",
    "元回答にない新しい事実、断定、推測を追加しないでください。",
    "スコア1位の回答を土台にしてよいが、他AIの有益な補足や注意点も自然に反映してください。",
    "主AIと補助AIを身分で差別しないでください。内容の根拠、具体性、質問適合性だけで公平に扱ってください。",
    "議長AIは整理専用です。新しい事実、推測、動画を見たふりを追加してはいけません。",
    "意見が割れている場合は、根拠が明確なものを優先し、不確実な点は注意点として残してください。",
    "最終結論としてそのまま読める自然な文章にしてください。",
  ].join("\n");
}

function buildChairPrompt(
  question: string,
  category: ConsultationCategory,
  answers: AiAnswer[],
  fallback: AnalysisResult["conclusion"],
  chair: AiAnswer,
) {
  const answerText = answers
    .map((answer, index) => {
      const bullets = answer.bullets.length ? answer.bullets.map((bullet) => `- ${bullet}`).join("\n") : "- 補足なし";
      const fullText = answer.fullText?.trim() || answer.summary;
      return [
        `AI ${index + 1}: ${answer.name}`,
        `状態: ${answer.status}`,
        `スコア: ${answer.confidence}`,
        `参加種別: ${answer.isHelper ? "補助枠" : "主AI枠"}`,
        `議長候補: ${answer.id === chair.id ? "はい" : "いいえ"}`,
        `要約: ${answer.summary}`,
        "回答全文:",
        fullText,
        "補足:",
        bullets,
      ].join("\n");
    })
    .join("\n\n");

  return [
    "ユーザーの質問:",
    question,
    "",
    `カテゴリ: ${category}`,
    "",
    "各AIの回答:",
    answerText,
    "",
    "既存システムによる統合案:",
    fallback.recommendation,
    "",
    "出力:",
    "見出しやMarkdownは使わず、最終結論を本文だけでまとめてください。質問が具体的な対象を求めている場合は、抽象的な栄養素や考え方だけで終わらせず、元回答にある具体例を必ず含めてください。必要な注意点は末尾に短く含めてください。",
  ].join("\n");
}

function trimToLength(text: string, max: number) {
  if (text.length <= max) return text;
  const sliced = text.slice(0, max);
  const lastPeriod = Math.max(sliced.lastIndexOf("。"), sliced.lastIndexOf("！"), sliced.lastIndexOf("？"));
  return lastPeriod > 120 ? sliced.slice(0, lastPeriod + 1).trim() : `${sliced.trim()}。`;
}

function normalizeAnalysisResult(result: AnalysisResult): AnalysisResult {
  return {
    ...result,
    conclusion: {
      ...result.conclusion,
      recommendation: repairRecommendation(result.question, result.conclusion.recommendation, result.answers),
      cautions: result.conclusion.cautions.filter((item) => !isUnavailableNotice(item)),
    },
  };
}

function repairRecommendation(question: string, recommendation: string, answers: AiAnswer[]) {
  let repaired = removeUnavailableNotice(recommendation);
  const examples = extractFoodExamples(question, answers);
  if (examples.length > 0 && !containsFoodExample(repaired)) {
    repaired = `${repaired.replace(/[。\s]*$/, "")}。具体的には、${examples.slice(0, 8).join("、")}などを優先すると分かりやすいです。`;
  }
  return repaired.trim();
}

function removeUnavailableNotice(text: string) {
  return text
    .replace(/(?:^|[。\s])(?:一部の候補|一部のAI|一部の回答|一部のモデル)[^。]*(?:取得できませんでした|取得失敗|使用できませんでした|利用できませんでした|採用できませんでした)[^。]*。?/g, "。")
    .replace(/。{2,}/g, "。")
    .replace(/^\s*。/, "")
    .trim();
}

function isUnavailableNotice(text: string) {
  return /(?:取得失敗|取得できませんでした|使用できませんでした|利用できませんでした|採用できませんでした|制限により採用)/.test(text);
}

function extractFoodExamples(question: string, answers: AiAnswer[]) {
  if (!/(食べ物|食べもの|食材|食品|食事|何を食べ|なにを食べ|料理|メニュー)/.test(question)) return [];
  const foodTerms = [
    "鶏むね肉", "鶏肉", "豚肉", "牛肉", "レバー", "卵", "鮭", "サバ", "マグロ", "カツオ", "魚",
    "納豆", "豆腐", "大豆", "枝豆", "ヨーグルト", "牛乳", "チーズ", "玄米", "白米", "ご飯",
    "オートミール", "全粒パン", "そば", "うどん", "パスタ", "じゃがいも", "さつまいも", "バナナ",
    "ほうれん草", "小松菜", "ブロッコリー", "にんじん", "トマト", "きのこ", "ナッツ", "アーモンド",
    "味噌汁", "豚汁", "カレー", "鍋", "おにぎり",
  ];
  const source = answers
    .filter((answer) => answer.status === "complete")
    .map((answer) => [answer.summary, answer.fullText, ...answer.bullets].filter(Boolean).join("\n"))
    .join("\n");
  return foodTerms.filter((term) => source.includes(term));
}

function containsFoodExample(text: string) {
  return /(鶏むね肉|鶏肉|豚肉|牛肉|レバー|卵|鮭|サバ|マグロ|カツオ|魚|納豆|豆腐|大豆|ヨーグルト|牛乳|チーズ|玄米|白米|ご飯|オートミール|全粒パン|そば|じゃがいも|さつまいも|バナナ|ほうれん草|小松菜|ブロッコリー|ナッツ|味噌汁|豚汁)/.test(text);
}

function adoptionReasonLabels(best: AiAnswer, ranked: AiAnswer[]) {
  const reasons = ["質問への適合性が高い", "内容の密度が高い"];
  if (best.confidence >= 82) reasons.push("完成度が高い");
  if (ranked.length > 1) reasons.push("他AIの有用な補足と整合した");
  reasons.push("単純な並列ではなく統合結論に向く");
  return reasons.slice(0, 4);
}

function buildPeerReviews(ranked: AiAnswer[]) {
  return ranked.slice(0, 3).map((answer) => {
    if (answer.isHelper) return `${answer.name}: 追加参加AIとして有用な視点を出しました`;
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

  if (isBillingOrBalanceError(raw, status)) {
    return mode === "simple"
      ? "このAIは現在使用できません。中継サーバー側のAPI残高を確認してください。"
      : "このAIのAPI残高・クレジット・課金設定が不足している可能性があります。各サービスのダッシュボードで残高、請求設定、利用上限を確認してください。";
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

function isBillingOrBalanceError(raw: string, status?: number) {
  return (
    status === 402 ||
    /insufficient[_\s-]?(balance|quota|credits?|funds)/i.test(raw) ||
    /(?:balance|credits?|quota|billing|payment|prepaid|top\s*up|recharge|spend limit|usage limit)/i.test(raw) ||
    /(?:残高|クレジット|課金|請求|支払い|利用上限|上限に達)/.test(raw)
  );
}

