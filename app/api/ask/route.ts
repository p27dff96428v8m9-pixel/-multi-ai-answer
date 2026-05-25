import { NextRequest, NextResponse } from "next/server";
import { AiAnswer, AnalysisResult, ConsultationCategory, ProviderConfig, UsageMode, builtInProviders } from "@/lib/dummy-ai";
import { askAdvancedProviders } from "@/lib/client-ai";
import { detectPrivacyRisks } from "@/lib/privacy-guard";
import { attachSourceContextToQuestion, resolveSourceContext } from "@/lib/source-context";
import { checkDailyLimit, getClientKey, usageLimits } from "@/lib/usage-limits";

export const runtime = "nodejs";

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
  customKeys?: Record<string, string>;
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
    const category = body.category ?? "life";

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

    const clientKey = getClientKey(request);
    const sourceContext = await resolveSourceContext(question);
    const enrichedQuestion = attachSourceContextToQuestion(question, sourceContext);

    if (body.mode === "advanced") {
      const usage = checkDailyLimit(`advanced:${clientKey}`, usageLimits.dailyAdvancedRequests);
      if (!usage.allowed) {
        return json({ error: `本日の詳細モード上限 ${usage.limit} 回に達しました。`, usage }, 429);
      }

      const response = await askAdvancedProviders({
        question: enrichedQuestion,
        category,
        mode: "advanced",
        providers: body.providers ?? [],
        customKeys: body.customKeys ?? {},
      });
      return json(response);
    }

    const usage = checkDailyLimit(`simple:${clientKey}`, usageLimits.dailySimpleRequests);
    if (!usage.allowed) {
      return json({ error: `本日の簡単モード上限 ${usage.limit} 回に達しました。`, usage }, 429);
    }

    const providers = normalizeProviders(body.providers);
    const results = await Promise.all(providers.map((provider) => callBuiltInProviderWithLimit(provider, category, enrichedQuestion, clientKey)));
    const answers = results.map((result) => toAnswer(result));

    const response: AnalysisResult = {
      question: enrichedQuestion,
      category,
      mode: "simple",
      answers,
      conclusion: await buildConclusion(enrichedQuestion, category, answers),
      generatedAt: new Date().toISOString(),
    };

    return json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "予期しないエラーが発生しました。";
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
  return { provider, error: `${provider.name} is not supported in simple mode.` };
}

async function callGemini(provider: ProviderConfig, category: ConsultationCategory, question: string): Promise<ProviderCallResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { provider, error: publicProviderError("simple") };

  const model = process.env.GEMINI_MODEL || provider.model;
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

  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "simple") };
  const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const content = finalizeSentence(data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "");
  return content ? { provider: { ...provider, model }, content } : { provider, error: "Geminiから本文を取得できませんでした。" };
}

async function callOpenRouter(provider: ProviderConfig, category: ConsultationCategory, question: string): Promise<ProviderCallResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { provider, error: publicProviderError("simple") };

  const models = provider.id === "qwen-free" ? thirdFreeModelCandidates(provider) : openRouterModelCandidates(provider);
  let lastError = publicProviderError("simple");

  for (const model of models) {
    const result = await callOpenRouterModel(provider, category, question, apiKey, model);
    if (result.content) return result;
    lastError = result.error ?? lastError;
  }

  return { provider, error: lastError };
}

async function callOpenRouterModel(
  provider: ProviderConfig,
  category: ConsultationCategory,
  question: string,
  apiKey: string,
  model: string,
): Promise<ProviderCallResult> {
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
        { role: "user", content: buildPrompt(question, provider, category) },
      ],
      temperature: 0.4,
      max_tokens: 900,
    }),
  });

  if (!response.ok) return { provider, error: await sanitizeProviderError(response, "simple") };
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (content && englishRatio(content) > 0.18) return { provider: { ...provider, model }, error: "英語混入が多いため再取得が必要です。" };
  return content ? { provider: { ...provider, model: data.model || model }, content } : { provider, error: "OpenRouterから本文を取得できませんでした。" };
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

  if (provider.id === "gemini-free") {
    return [
      "役割: 初心者向け整理・補足説明",
      categoryHint,
      "得意分野: わかりやすい説明 / 初心者向け整理 / 全体把握 / 要点整理",
      "指示: 必ず質問に直接答える。初心者でも理解できる説明にする。結論ファーストで、具体例を入れる。説明不足と回答未完成は禁止。他AIと同じ内容をなぞらず、わかりやすい補足を担当する。",
      "文字数目安: 通常 300〜500文字 / 専門質問 500〜900文字",
      "安全: 一般的な情報として回答する。医療診断は禁止。性的表現は禁止。危険行為の推奨は禁止。",
      "禁止: 自己紹介 / こんにちは / ものしり博士 / 無意味な前置き / 内容の薄い短文 / Markdown",
      "注意: 途中で切れたような回答は必ず再生成し、最後まで答える。",
    ].join("\n");
  }

  if (provider.id === "openrouter-free") {
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
    bullets: hasError ? [result.error ?? publicProviderError("simple")] : extractBullets(content, summary),
    fullText: hasError ? undefined : content,
    costLabel: result.provider.costLabel,
    origin: result.provider.origin,
    errorMessage: result.error,
  };
}

async function buildConclusion(question: string, category: ConsultationCategory, answers: AiAnswer[]): Promise<AnalysisResult["conclusion"]> {
  const fallback = buildSystemConclusion(question, category, answers);
  const chaired = await buildChairConclusion(question, category, answers, fallback, "simple");
  return chaired ?? fallback;
}

async function callBuiltInProviderWithLimit(provider: ProviderConfig, category: ConsultationCategory, question: string, clientKey: string): Promise<ProviderCallResult> {
  const usage = checkDailyLimit(`simple-provider:${provider.id}:${clientKey}`, usageLimits.dailyFreeProviderRequests);
  if (!usage.allowed) {
    return { provider, error: `${provider.name}は本日の無料参加上限 ${usage.limit} 回に達しました。別の無料AIを選択してください。` };
  }
  return callBuiltInProvider(provider, category, question);
}

function buildSystemConclusion(question: string, category: ConsultationCategory, answers: AiAnswer[]): AnalysisResult["conclusion"] {
  const completed = answers.filter((answer) => answer.status === "complete");
  const failed = answers.filter((answer) => answer.status === "error");
  const safetyNote =
    category === "health"
      ? "これは一般的な情報です。診断や治療ではありません。症状が強い場合や不安がある場合は医療機関に相談してください。"
      : undefined;

  if (completed.length === 0) {
    return {
      recommendation: "有効なAI回答が得られませんでした。APIキーと接続設定を確認して、もう一度実行してください。",
      reason: "簡単モードでは、各AIに設定されたAPIキーや中継先の設定が必要です。回答が取得できないと合議も作れません。",
      alternatives: ["有効なAPIキーを設定する", "使うAIを1つ以上有効化する", "接続先の制限やエラー内容を確認する"],
      cautions: failed.map((answer) => `${answer.name}: ${answer.errorMessage ?? publicProviderError("simple")}`),
      safetyNote,
    };
  }

  const ranked = [...completed].sort((a, b) => b.confidence - a.confidence);
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
  mode: "simple" | "advanced",
): Promise<AnalysisResult["conclusion"] | null> {
  const candidates = answers
    .filter((answer) => answer.status === "complete" && answer.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);

  for (const candidate of candidates) {
    try {
      const provider = answerToProvider(candidate);
      const prompt = buildChairPrompt(question, category, answers, fallback, candidate);
      const result = await callChairProvider(provider, prompt, mode);
      const recommendation = cleanAnswerText(result.content ?? "");
      if (recommendation.length >= 80) {
        return {
          ...fallback,
          recommendation: repairRecommendation(question, trimToLength(recommendation, 900), answers),
          reason: `議長AI（${candidate.name}）が、全AIの回答を公平に比較して最終結論を再統合しました。`,
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
  };
}

async function callChairProvider(provider: ProviderConfig, prompt: string, mode: "simple" | "advanced"): Promise<ProviderCallResult> {
  if (provider.id === "gemini-free") return callGeminiChair(provider, prompt, mode);
  if (provider.id === "openrouter-free" || provider.id === "qwen-free") return callOpenRouterChair(provider, prompt, mode);
  return { provider, error: `${provider.name} is not supported as chair in simple mode.` };
}

async function callGeminiChair(provider: ProviderConfig, prompt: string, mode: "simple" | "advanced"): Promise<ProviderCallResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { provider, error: publicProviderError(mode) };

  const model = process.env.GEMINI_MODEL || provider.model;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${chairSystemInstruction()}\n\n${prompt}` }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1000 },
    }),
  });

  if (!response.ok) return { provider, error: await sanitizeProviderError(response, mode) };
  const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const content = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  return content ? { provider: { ...provider, model }, content } : { provider, error: "議長AIから本文を取得できませんでした。" };
}

async function callOpenRouterChair(provider: ProviderConfig, prompt: string, mode: "simple" | "advanced"): Promise<ProviderCallResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { provider, error: publicProviderError(mode) };

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
      "X-Title": "AI Multi Answer",
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: "system", content: chairSystemInstruction() },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 1000,
    }),
  });

  if (!response.ok) return { provider, error: await sanitizeProviderError(response, mode) };
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (content && englishRatio(content) > 0.18) return { provider: { ...provider, model: data.model || provider.model }, error: "英語混入が多いため議長AIとして採用できません。" };
  return content ? { provider: { ...provider, model: data.model || provider.model }, content } : { provider, error: "議長AIから本文を取得できませんでした。" };
}

function chairSystemInstruction() {
  return [
    "あなたは複数AI会議の議長AIです。",
    "日本語のみで、挨拶や自己紹介なしで回答してください。",
    "あなた自身の元回答を特別扱いせず、全AIの回答を公平に比較してください。",
    "自分の考えを強く押し出さず、元回答に含まれる根拠と有用な補足だけを統合してください。",
    "元回答にない新しい事実、断定、推測を追加しないでください。",
    "議長AIは整理専用です。新しい結論を作るのではなく、既存回答を公平に統合してください。",
    "動画URLの内容は取得済み情報だけを根拠にし、動画を見たふりをしないでください。",
    "スコア1位の回答を土台にしてよいが、他AIの有益な補足や注意点も自然に反映してください。",
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
  return ranked.slice(0, 3).map((answer, index) => {
    const base =
      answer.name === "Gemini Free"
        ? "要点整理が強いが、深い統合は弱め"
        : answer.name === "GPT OSS Free"
          ? "実装寄りで有用だが、結論の磨き込みは別途必要"
          : answer.name === "OpenRouter Free"
            ? "補足とリスク確認が強く、反対意見の役割に向く"
            : "補足として有用";
    return `${answer.name}: ${base}`;
  });
}

function nonAdoptionReason(answer: AiAnswer, best: AiAnswer) {
  if (answer.confidence + 8 < best.confidence) return "最終結論の軸にするには情報密度が少し足りませんでした";
  return "補足としては有用ですが、主役にするほどではありませんでした";
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

function openRouterModelCandidates(provider: ProviderConfig) {
  return uniqueModels([process.env.OPENROUTER_FREE_MODEL, provider.model, "openai/gpt-oss-20b:free", "meta-llama/llama-3.2-3b-instruct:free"]);
}

function thirdFreeModelCandidates(provider: ProviderConfig) {
  return uniqueModels([
    process.env.OPENROUTER_QWEN_MODEL,
    provider.model,
    "openai/gpt-oss-20b:free",
    "meta-llama/llama-3.2-3b-instruct:free",
    "z-ai/glm-4.5-air:free",
    "google/gemma-4-26b-a4b-it:free",
  ]);
}

function uniqueModels(models: Array<string | undefined>) {
  return Array.from(new Set(models.map((model) => model?.trim()).filter((model): model is string => Boolean(model))));
}

