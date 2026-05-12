export type ConsultationCategory = "development" | "life" | "health" | "business" | "learning";
export type UsageMode = "simple" | "advanced";
export type ProviderId = "gemini-free" | "openrouter-free" | "qwen-free" | "deepseek" | "openai" | "anthropic" | "gemini" | "openrouter";

export type ProviderConfig = {
  id: ProviderId;
  name: string;
  model: string;
  role: string;
  costLabel: string;
  origin: "built-in" | "custom";
  enabled: boolean;
  hasApiKey?: boolean;
};

export type AiAnswer = {
  id: string;
  name: string;
  model: string;
  role: string;
  status: "ready" | "running" | "complete" | "error";
  confidence: number;
  summary: string;
  bullets: string[];
  costLabel: string;
  origin: "built-in" | "custom";
  errorMessage?: string;
};

export type AnalysisResult = {
  question: string;
  category: ConsultationCategory;
  mode: UsageMode;
  answers: AiAnswer[];
  conclusion: {
    recommendation: string;
    reason: string;
    alternatives: string[];
    cautions: string[];
    safetyNote?: string;
  };
  generatedAt: string;
};

export const categoryLabels: Record<ConsultationCategory, string> = {
  development: "開発",
  life: "生活",
  health: "健康・食事",
  business: "ビジネス",
  learning: "学習",
};

export const builtInProviders: ProviderConfig[] = [
  {
    id: "gemini-free",
    name: "Gemini Free",
    model: "gemini-2.5-flash",
    role: "整理初心者向け解説担当",
    costLabel: "簡単モード",
    origin: "built-in",
    enabled: true,
  },
  {
    id: "openrouter-free",
    name: "OpenRouter Free",
    model: "openrouter/auto",
    role: "批判補足リスク担当",
    costLabel: "簡単モード",
    origin: "built-in",
    enabled: true,
  },
  {
    id: "qwen-free",
    name: "GPT OSS Free",
    model: "openai/gpt-oss-20b:free",
    role: "技術実装具体例担当",
    costLabel: "簡単モード",
    origin: "built-in",
    enabled: true,
  },
];

export const customProviders: ProviderConfig[] = [
  {
    id: "openai",
    name: "OpenAI",
    model: "gpt-4.1-mini",
    role: "実装・整理・推論の補助",
    costLabel: "ユーザーAPIキー",
    origin: "custom",
    enabled: false,
  },
  {
    id: "anthropic",
    name: "Claude",
    model: "claude-sonnet-4-5",
    role: "設計・文章・注意点の補助",
    costLabel: "ユーザーAPIキー",
    origin: "custom",
    enabled: false,
  },
  {
    id: "gemini",
    name: "Gemini",
    model: "gemini-2.5-flash",
    role: "整理初心者向け解説担当",
    costLabel: "ユーザーAPIキー",
    origin: "custom",
    enabled: false,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    model: "deepseek-chat",
    role: "低コストな推論・開発相談",
    costLabel: "ユーザーAPIキー",
    origin: "custom",
    enabled: false,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    model: "openrouter/auto",
    role: "複数モデル経由の補足意見",
    costLabel: "ユーザーAPIキー",
    origin: "custom",
    enabled: false,
  },
];
