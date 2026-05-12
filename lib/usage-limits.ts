import { NextRequest } from "next/server";

export const usageLimits = {
  dailySimpleRequests: Number(process.env.DAILY_SIMPLE_REQUEST_LIMIT ?? 10),
  dailyAdvancedRequests: Number(process.env.DAILY_ADVANCED_REQUEST_LIMIT ?? 30),
  maxQuestionLength: Number(process.env.MAX_QUESTION_LENGTH ?? 1200),
  simpleProviderLimit: Math.max(3, Number(process.env.SIMPLE_PROVIDER_LIMIT ?? 3)),
};

type UsageRecord = {
  date: string;
  count: number;
};

const usageStore = new Map<string, UsageRecord>();

export function getClientKey(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  return forwardedFor || realIp || "local";
}

export function checkDailyLimit(clientKey: string, limit: number) {
  const today = new Date().toISOString().slice(0, 10);
  const current = usageStore.get(clientKey);

  if (!current || current.date !== today) {
    usageStore.set(clientKey, { date: today, count: 1 });
    return { allowed: true, remaining: Math.max(0, limit - 1), limit };
  }

  if (current.count >= limit) {
    return { allowed: false, remaining: 0, limit };
  }

  current.count += 1;
  usageStore.set(clientKey, current);
  return { allowed: true, remaining: Math.max(0, limit - current.count), limit };
}
