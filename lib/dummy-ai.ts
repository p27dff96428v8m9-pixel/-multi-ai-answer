export type ConsultationCategory = "development" | "life" | "health" | "business" | "learning";
export type UsageMode = "simple" | "advanced";
export type ProviderId = "gemini-free" | "openrouter-free" | "qwen-free" | "deepseek" | "openai" | "anthropic" | "grok" | "openrouter";

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
    role: "初心者向け整理・補足説明",
    costLabel: "簡単モード",
    origin: "built-in",
    enabled: true,
  },
  {
    id: "openrouter-free",
    name: "OpenRouter Free",
    model: "openrouter/auto",
    role: "補足・批判・比較・追加視点",
    costLabel: "簡単モード",
    origin: "built-in",
    enabled: true,
  },
  {
    id: "qwen-free",
    name: "GPT OSS Free",
    model: "openai/gpt-oss-20b:free",
    role: "実装・整理・推論補助",
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
    role: "実装・整理・推論補助",
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
    id: "grok",
    name: "Grok",
    model: "x-ai/grok-4.3",
    role: "反対意見・別視点・鋭い指摘担当",
    costLabel: "ユーザーAPIキー",
    origin: "custom",
    enabled: false,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    model: "deepseek-chat",
    role: "低コスト推論・開発相談・別解提示",
    costLabel: "ユーザーAPIキー",
    origin: "custom",
    enabled: false,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    model: "openrouter/auto",
    role: "補足・批判・比較・追加視点",
    costLabel: "ユーザーAPIキー",
    origin: "custom",
    enabled: false,
  },
];
