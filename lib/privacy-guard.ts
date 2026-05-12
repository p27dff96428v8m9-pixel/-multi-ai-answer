export type PrivacyRisk = {
  label: string;
  description: string;
};

const privacyPatterns: Array<{ label: string; description: string; pattern: RegExp }> = [
  {
    label: "メールアドレス",
    description: "メールアドレスらしい文字列が含まれています。",
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  },
  {
    label: "電話番号",
    description: "電話番号らしい数字列が含まれています。",
    pattern: /(?:\+?\d{1,3}[-\s]?)?(?:0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}|\d{3}[-\s]\d{3,4}[-\s]\d{4})/,
  },
  {
    label: "郵便番号",
    description: "郵便番号らしい文字列が含まれています。",
    pattern: /\b\d{3}-\d{4}\b/,
  },
  {
    label: "APIキー・トークン",
    description: "APIキーやアクセストークンらしい文字列が含まれています。",
    pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,})\b/,
  },
  {
    label: "パスワード記述",
    description: "パスワードや秘密情報の記述らしい表現が含まれています。",
    pattern: /(password|passwd|pwd|pass|パスワード|認証番号|private key|api key|apikey|token|トークン)\s*[:：=]/i,
  },
];

export function detectPrivacyRisks(input: string): PrivacyRisk[] {
  const risks = privacyPatterns
    .filter((item) => item.pattern.test(input))
    .map((item) => ({ label: item.label, description: item.description }));

  return Array.from(new Map(risks.map((risk) => [risk.label, risk])).values());
}
