"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  AnalysisResult,
  ConsultationCategory,
  ProviderConfig,
  UsageMode,
  builtInProviders,
  customProviders,
} from "@/lib/dummy-ai";
import { askAdvancedProviders, askSimpleRelay, getSimpleRelayUrl } from "@/lib/client-ai";
import { detectPrivacyRisks } from "@/lib/privacy-guard";

const DEFAULT_CATEGORY: ConsultationCategory = "development";
const PLACEHOLDER = "例：このWebアプリの改善点を教えて";
const SIMPLE_DESCRIPTION = "複数のAIに一度で質問し、最後に最適な答えをまとめます。";
const ADVANCED_DESCRIPTION = "入力したAPIキーを使って、選択したAIに直接問い合わせます。";
const WARNING_TEXT = "※ APIキー・パスワードなどの機密情報は入力しないでください。";
const initialCustomKeys = Object.fromEntries(customProviders.map((provider) => [provider.id, ""]));

export function MultiAiTool() {
  const [mode, setMode] = useState<UsageMode>("simple");
  const [question, setQuestion] = useState("");
  const [customKeys, setCustomKeys] = useState<Record<string, string>>(initialCustomKeys);
  const [enabledCustomIds, setEnabledCustomIds] = useState<string[]>(customProviders.map((provider) => provider.id));
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [showFinalAnswer, setShowFinalAnswer] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  const allProviders = useMemo(() => buildProviders(mode, customKeys, enabledCustomIds), [mode, customKeys, enabledCustomIds]);
  const requestProviders = useMemo(() => allProviders.filter((provider) => provider.enabled), [allProviders]);
  const completedAnswers = result?.answers.filter((answer) => answer.status === "complete") ?? [];
  const privacyRisks = useMemo(() => detectPrivacyRisks(question), [question]);
  const simpleRelayUrl = getSimpleRelayUrl();

  function resetOutput() {
    setResult(null);
    setShowFinalAnswer(false);
    setErrorMessage("");
  }

  function handleModeChange(nextMode: UsageMode) {
    setMode(nextMode);
    resetOutput();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();

    if (!trimmedQuestion) {
      setErrorMessage("質問を入力してください。");
      return;
    }

    if (privacyRisks.length > 0) {
      setErrorMessage("個人情報やAPIキーなどの機密情報が含まれている可能性があります。伏せ字にしてから送信してください。");
      return;
    }

    if (mode === "advanced" && requestProviders.length === 0) {
      setErrorMessage("詳細モードでは、有効なAPIキーを少なくとも1つ入力してください。");
      return;
    }

    setIsRunning(true);
    setErrorMessage("");
    setResult(null);
    setShowFinalAnswer(false);

    try {
      const data =
        mode === "advanced"
          ? await askAdvancedProviders({
              question: trimmedQuestion,
              category: DEFAULT_CATEGORY,
              mode,
              providers: requestProviders,
              customKeys,
            })
          : await askSimpleRelay({
              question: trimmedQuestion,
              category: DEFAULT_CATEGORY,
              mode,
              providers: requestProviders,
            });

      setResult(data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "回答の取得に失敗しました。");
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f7f3] text-[#17211b]">
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-5 sm:px-6 sm:py-8">
        <header className="space-y-4 border-b border-[#d6ddd4] pb-5">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-normal text-[#17211b] sm:text-4xl">複数AIアンサー</h1>
            <p className="max-w-3xl text-sm leading-6 text-[#4b5a50]">{mode === "simple" ? SIMPLE_DESCRIPTION : ADVANCED_DESCRIPTION}</p>
          </div>
          <ModeSwitch mode={mode} onChange={handleModeChange} simpleRelayUrl={simpleRelayUrl} />
        </header>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
          <section className="space-y-5">
            <form className="space-y-4 rounded-lg border border-[#d6ddd4] bg-white p-4 shadow-sm sm:p-5" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <label className="text-sm font-semibold text-[#243227]" htmlFor="question">
                  質問
                </label>
                <textarea
                  id="question"
                  value={question}
                  onChange={(event) => {
                    setQuestion(event.target.value);
                    resetOutput();
                  }}
                  className="min-h-48 w-full resize-y rounded-md border border-[#c6cec8] bg-[#fbfcfa] p-3 text-base leading-7 outline-none transition focus:border-[#2f6b49] focus:ring-4 focus:ring-[#2f6b49]/15"
                  placeholder={PLACEHOLDER}
                />
                <p className="text-xs leading-5 text-[#7a837c]">{WARNING_TEXT}</p>
              </div>

              {privacyRisks.length > 0 ? <PrivacyWarning labels={privacyRisks.map((risk) => risk.label)} /> : null}
              {errorMessage ? <StatusBox title="エラー" body={errorMessage} tone="error" /> : null}

              <button
                type="submit"
                disabled={isRunning || !question.trim() || privacyRisks.length > 0}
                className="w-full rounded-md bg-[#245f41] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#1d4d35] disabled:cursor-not-allowed disabled:bg-[#8ca897]"
              >
                {isRunning ? "複数AIに質問しています..." : "複数AIに質問する"}
              </button>
            </form>

            {isRunning ? <LoadingOutput providers={requestProviders} /> : null}
            {!isRunning && !result ? <EmptyOutput /> : null}
            {result ? (
              <>
                <AnswerList answers={result.answers} />
                <ConsensusAction disabled={completedAnswers.length === 0} onClick={() => setShowFinalAnswer(true)} />
                {showFinalAnswer ? <FinalAnswerCard result={result} /> : null}
              </>
            ) : null}
          </section>

          <aside className="space-y-4">
            <ProviderSummary mode={mode} providers={mode === "simple" ? requestProviders : allProviders} />
            {mode === "advanced" ? (
              <ApiKeyPanel
                customKeys={customKeys}
                enabledCustomIds={enabledCustomIds}
                onToggle={(id) => {
                  setEnabledCustomIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
                  resetOutput();
                }}
                onChangeKey={(id, value) => {
                  setCustomKeys((current) => ({ ...current, [id]: value }));
                  resetOutput();
                }}
              />
            ) : null}
          </aside>
        </div>
      </section>
    </main>
  );
}

function buildProviders(mode: UsageMode, customKeys: Record<string, string>, enabledCustomIds: string[]): ProviderConfig[] {
  if (mode === "simple") return builtInProviders.filter((provider) => provider.enabled);

  return customProviders.map((provider) => {
    const hasApiKey = Boolean(customKeys[provider.id]?.trim());
    return {
      ...provider,
      enabled: enabledCustomIds.includes(provider.id) && hasApiKey,
      hasApiKey,
    };
  });
}

function ModeSwitch({ mode, simpleRelayUrl, onChange }: { mode: UsageMode; simpleRelayUrl: string; onChange: (mode: UsageMode) => void }) {
  return (
    <div className="inline-grid w-full max-w-sm grid-cols-2 gap-1 rounded-lg border border-[#d6ddd4] bg-white p-1 shadow-sm">
      <button
        type="button"
        onClick={() => onChange("simple")}
        className={`rounded-md px-3 py-2 text-sm font-semibold transition ${mode === "simple" ? "bg-[#245f41] text-white" : "text-[#34443a] hover:bg-[#eef5ef]"}`}
      >
        簡単
      </button>
      <button
        type="button"
        onClick={() => onChange("advanced")}
        className={`rounded-md px-3 py-2 text-sm font-semibold transition ${mode === "advanced" ? "bg-[#245f41] text-white" : "text-[#34443a] hover:bg-[#eef5ef]"}`}
        title={simpleRelayUrl ? "中継サーバーを使用中" : "ローカルAPIを使用中"}
      >
        詳細
      </button>
    </div>
  );
}

function ProviderSummary({ mode, providers }: { mode: UsageMode; providers: ProviderConfig[] }) {
  return (
    <section className="rounded-lg border border-[#d6ddd4] bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold text-[#4f6f56]">{mode === "simple" ? "使用するAI" : "詳細AI設定"}</p>
      <div className="mt-3 grid gap-2">
        {providers.map((provider) => (
          <ProviderRow key={provider.id} provider={provider} showModel={mode === "advanced"} />
        ))}
      </div>
    </section>
  );
}

function ProviderRow({ provider, showModel }: { provider: ProviderConfig; showModel?: boolean }) {
  return (
    <div className="rounded-md border border-[#e2e7e3] bg-[#fbfcfa] p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-[#243227]">{provider.name}</p>
          {showModel ? <p className="mt-1 text-xs leading-5 text-[#6b756d]">{provider.model}</p> : null}
        </div>
        <span className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${provider.hasApiKey === false ? "bg-[#fff1ef] text-[#8a312a]" : "bg-[#eef5ef] text-[#2f6b49]"}`}>
          {provider.origin === "built-in" ? "中継" : provider.hasApiKey ? "有効" : "キー未入力"}
        </span>
      </div>
    </div>
  );
}

function EmptyOutput() {
  return (
    <section className="rounded-lg border border-dashed border-[#c6cec8] bg-white/60 p-5 text-center">
      <p className="text-sm leading-6 text-[#4b5a50]">質問すると、複数AIの回答がここに表示されます。</p>
    </section>
  );
}

function LoadingOutput({ providers }: { providers: ProviderConfig[] }) {
  return (
    <section className="rounded-lg border border-[#cdd8d0] bg-[#eef5ef] p-5">
      <p className="text-sm font-semibold text-[#2f6b49]">実行中</p>
      <h2 className="mt-1 text-xl font-bold text-[#17211b]">AIへ問い合わせ中</h2>
      <div className="mt-4 grid gap-2">
        {providers.map((provider) => (
          <div key={provider.id} className="flex items-center justify-between rounded-md bg-white px-3 py-2 text-sm">
            <span className="font-semibold text-[#243227]">{provider.name}</span>
            <span className="text-[#6b756d]">処理中</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function AnswerList({ answers }: { answers: AnalysisResult["answers"] }) {
  const completed = answers.filter((answer) => answer.status === "complete");
  const failed = answers.filter((answer) => answer.status === "error");
  const visibleAnswers = completed.length > 0 ? completed : answers;

  return (
    <section className="space-y-3">
      <div>
        <p className="text-sm font-semibold text-[#4f6f56]">各AIの回答</p>
        <h2 className="mt-1 text-xl font-bold text-[#17211b]">回答一覧</h2>
      </div>
      {failed.length > 0 && completed.length > 0 ? <SkippedProvidersNotice count={failed.length} /> : null}
      <div className="grid gap-3">
        {visibleAnswers.map((answer) => (
          <article key={answer.id} className="rounded-lg border border-[#d6ddd4] bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-[#17211b]">{answer.name}</h3>
                <p className="mt-1 text-xs font-semibold text-[#6b756d]">{answer.status === "error" ? "エラー" : answer.costLabel}</p>
              </div>
              <span className={`rounded-md px-2 py-1 text-xs font-semibold ${answer.status === "error" ? "bg-[#fff1ef] text-[#8a312a]" : "bg-[#f1f4f2] text-[#2f6b49]"}`}>
                {answer.status === "error" ? "失敗" : `${answer.confidence}%`}
              </span>
            </div>
            <p className="mt-3 text-sm leading-6 text-[#4b5a50]">{answer.summary}</p>
            <ul className="mt-4 space-y-2">
              {answer.bullets.map((bullet) => (
                <li key={bullet} className="rounded-md bg-[#f8faf7] px-3 py-2 text-sm leading-6 text-[#34443a]">
                  {bullet}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

function SkippedProvidersNotice({ count }: { count: number }) {
  return (
    <div className="rounded-md border border-[#e3c46f] bg-[#fff8df] px-3 py-2 text-xs leading-5 text-[#5c4a12]">
      {count}件のAIは混雑または一時的な制限のためスキップしました。取得できた回答だけで結果をまとめています。
    </div>
  );
}

function ConsensusAction({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-full rounded-md bg-[#245f41] px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#1d4d35] disabled:cursor-not-allowed disabled:bg-[#8ca897]"
    >
      AI合議で最適解を出す
    </button>
  );
}

function FinalAnswerCard({ result }: { result: AnalysisResult }) {
  return (
    <section className="rounded-lg border border-[#b8d1bf] bg-[#eef5ef] p-5 shadow-sm">
      <p className="text-sm font-semibold text-[#2f6b49]">最終回答</p>
      <h2 className="mt-1 text-2xl font-bold text-[#17211b]">AI合議による最適解</h2>
      {result.conclusion.safetyNote ? <StatusBox title="注意" body={result.conclusion.safetyNote} tone="warning" /> : null}
      <div className="mt-4 grid gap-3">
        <ConclusionBlock title="結論" body={result.conclusion.recommendation} strong />
        <ConclusionBlock title="理由" body={result.conclusion.reason} />
        <ConclusionList title="参考意見" items={result.conclusion.alternatives} />
        <ConclusionList title="注意点" items={result.conclusion.cautions} />
      </div>
    </section>
  );
}

function ApiKeyPanel({
  customKeys,
  enabledCustomIds,
  onToggle,
  onChangeKey,
}: {
  customKeys: Record<string, string>;
  enabledCustomIds: string[];
  onToggle: (id: string) => void;
  onChangeKey: (id: string, value: string) => void;
}) {
  return (
    <details className="rounded-lg border border-[#d6ddd4] bg-white p-4 shadow-sm">
      <summary className="cursor-pointer text-sm font-semibold text-[#243227]">詳細設定（APIキー）</summary>
      <div className="mt-4 grid gap-3">
        {customProviders.map((provider) => {
          const selected = enabledCustomIds.includes(provider.id);
          const hasApiKey = Boolean(customKeys[provider.id]?.trim());
          return (
            <div key={provider.id} className="rounded-md border border-[#d6ddd4] bg-[#fbfcfa] p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-[#243227]">{provider.name}</p>
                  <p className="mt-1 text-xs text-[#6b756d]">{hasApiKey ? "キー入力済み" : "キー未入力"}</p>
                </div>
                <button type="button" onClick={() => onToggle(provider.id)} className={`rounded-md px-3 py-2 text-xs font-semibold ${selected ? "bg-[#245f41] text-white" : "bg-[#e8ece9] text-[#34443a]"}`}>
                  {selected ? "有効" : "無効"}
                </button>
              </div>
              <label className="mt-3 block text-xs font-semibold text-[#34443a]" htmlFor={`key-${provider.id}`}>
                APIキー
              </label>
              <input
                id={`key-${provider.id}`}
                type="password"
                value={customKeys[provider.id] ?? ""}
                onChange={(event) => onChangeKey(provider.id, event.target.value)}
                placeholder="API key"
                className="mt-2 w-full rounded-md border border-[#c6cec8] bg-white px-3 py-2 text-sm outline-none transition focus:border-[#2f6b49] focus:ring-4 focus:ring-[#2f6b49]/15"
              />
            </div>
          );
        })}
      </div>
    </details>
  );
}

function PrivacyWarning({ labels }: { labels: string[] }) {
  return (
    <div className="rounded-md border border-[#e3a29c] bg-[#fff1ef] p-3 text-[#7a2f28]">
      <p className="text-sm font-bold">送信できない情報が含まれている可能性があります。</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {labels.map((label) => (
          <span key={label} className="rounded-md bg-white px-2 py-1 text-xs font-semibold">
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function StatusBox({ tone, title, body }: { tone: "warning" | "error"; title: string; body: string }) {
  const styles = tone === "warning" ? "border-[#e3c46f] bg-[#fff8df] text-[#5c4a12]" : "border-[#e3a29c] bg-[#fff1ef] text-[#7a2f28]";
  return (
    <div className={`rounded-md border px-3 py-2 text-sm leading-6 ${styles}`}>
      <span className="font-bold">{title}: </span>
      {body}
    </div>
  );
}

function ConclusionBlock({ title, body, strong = false }: { title: string; body: string; strong?: boolean }) {
  return (
    <section className="rounded-md border border-[#d6ddd4] bg-white p-3">
      <h3 className="text-sm font-bold text-[#243227]">{title}</h3>
      <p className={`mt-2 text-sm leading-7 ${strong ? "font-semibold text-[#17211b]" : "text-[#34443a]"}`}>{body}</p>
    </section>
  );
}

function ConclusionList({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="rounded-md border border-[#d6ddd4] bg-white p-3">
      <h3 className="text-sm font-bold text-[#243227]">{title}</h3>
      <ul className="mt-2 space-y-2">
        {(items.length ? items : ["なし"]).map((item) => (
          <li key={item} className="rounded-md bg-[#f8faf7] px-3 py-2 text-sm leading-6 text-[#34443a]">
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}
