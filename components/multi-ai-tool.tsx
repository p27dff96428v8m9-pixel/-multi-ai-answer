"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
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
const PLACEHOLDER = "質問を入力してください";
const SIMPLE_DESCRIPTION = "複数AIが同時に考え、最後にAI同士の合議で最適解を導きます。";
const ADVANCED_DESCRIPTION = "あなたのAPIキーでAIチームを編成し、回答を比較して合議できます。";
const WARNING_TEXT = "※ APIキー・パスワードなどの機密情報は入力しないでください。";
const initialCustomKeys = Object.fromEntries(customProviders.map((provider) => [provider.id, ""]));
const HISTORY_KEY = "multi-ai-answer-history-v1";
const HISTORY_LIMIT = 20;

type HistoryEntry = {
  id: string;
  question: string;
  generatedAt: string;
  result: AnalysisResult;
  locked?: boolean;
};

export function MultiAiTool() {
  const [mode, setMode] = useState<UsageMode>("simple");
  const [question, setQuestion] = useState("");
  const [customKeys, setCustomKeys] = useState<Record<string, string>>(initialCustomKeys);
  const [enabledCustomIds, setEnabledCustomIds] = useState<string[]>(customProviders.map((provider) => provider.id));
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [showFinalAnswer, setShowFinalAnswer] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const allProviders = useMemo(() => buildProviders(mode, customKeys, enabledCustomIds), [mode, customKeys, enabledCustomIds]);
  const requestProviders = useMemo(() => allProviders.filter((provider) => provider.enabled), [allProviders]);
  const completedAnswers = result?.answers.filter((answer) => answer.status === "complete") ?? [];
  const privacyRisks = useMemo(() => detectPrivacyRisks(question), [question]);
  const simpleRelayUrl = getSimpleRelayUrl();

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  function resetOutput() {
    setResult(null);
    setShowFinalAnswer(false);
    setErrorMessage("");
  }

  function handleModeChange(nextMode: UsageMode) {
    setMode(nextMode);
    resetOutput();
  }

  function saveHistoryEntry(nextResult: AnalysisResult) {
    const entry: HistoryEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      question: nextResult.question,
      generatedAt: nextResult.generatedAt,
      result: nextResult,
    };
    setHistory((current) => {
      const next = trimHistory([entry, ...current]);
      persistHistory(next);
      return next;
    });
  }

  function openHistoryEntry(entry: HistoryEntry) {
    setQuestion(entry.question);
    setResult(entry.result);
    setShowFinalAnswer(true);
    setErrorMessage("");
  }

  function clearHistory() {
    setHistory((current) => {
      const next = current.filter((entry) => entry.locked);
      persistHistory(next);
      return next;
    });
  }

  function toggleHistoryLock(id: string) {
    setHistory((current) => {
      const next = trimHistory(current.map((entry) => (entry.id === id ? { ...entry, locked: !entry.locked } : entry)));
      persistHistory(next);
      return next;
    });
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
      setShowFinalAnswer(true);
      saveHistoryEntry(data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "回答の取得に失敗しました。");
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <main className="min-h-screen max-w-full overflow-x-hidden bg-[#edf3f1] text-[#10211d]">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-5 sm:px-6 sm:py-8">
        <header className="overflow-hidden rounded-lg border border-[#b9d4cc] bg-[#0f211d] text-white shadow-lg">
          <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-end">
            <div className="min-w-0 space-y-3">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#7edfc3]">AI Council Console</p>
              <h1 className="text-3xl font-bold tracking-normal sm:text-4xl">複数AIアンサー</h1>
              <p className="max-w-full break-words text-sm leading-6 text-[#d8e9e3]">{mode === "simple" ? SIMPLE_DESCRIPTION : ADVANCED_DESCRIPTION}</p>
              <p className="max-w-full break-words text-xs leading-5 text-[#a9bcb5]">
                簡単モードは1日10回まで、質問は1200文字までです。健康・食事に関する回答は一般情報であり、診断や治療ではありません。
              </p>
              <div className="grid gap-2 pt-1 text-xs text-[#d8e9e3] sm:grid-cols-3">
                <StatusPill label="01 質問解析" active={isRunning} />
                <StatusPill label="02 AIチーム回答" active={isRunning || Boolean(result)} />
                <StatusPill label="03 合議で統合" active={showFinalAnswer} />
              </div>
            </div>
            <div className="min-w-0 space-y-3">
              <ModeSwitch mode={mode} onChange={handleModeChange} simpleRelayUrl={simpleRelayUrl} />
              <div className="max-w-full break-words rounded-lg border border-white/10 bg-white/8 p-3 text-xs leading-5 text-[#d8e9e3]">
                <span className="font-semibold text-[#7edfc3]">現在のチーム:</span> {requestProviders.length} AIが待機中
              </div>
            </div>
          </div>
        </header>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
          <section className="space-y-5">
            <form className="max-w-full space-y-4 overflow-x-hidden rounded-lg border border-[#b9d4cc] bg-white p-4 shadow-md sm:p-5" onSubmit={handleSubmit}>
              <div className="space-y-2">
                <label className="flex max-w-full flex-wrap items-center justify-between gap-3 text-sm font-semibold text-[#243227]" htmlFor="question">
                  <span className="min-w-0">指令入力</span>
                  <span className="max-w-full rounded-md bg-[#e8f4ef] px-2 py-1 text-xs text-[#28614d]">AIチームへ送信</span>
                </label>
                <textarea
                  id="question"
                  value={question}
                  onChange={(event) => {
                    setQuestion(event.target.value);
                    resetOutput();
                  }}
                  className="min-h-44 w-full max-w-full resize-y rounded-md border border-[#a9c5bc] bg-[#fbfefd] p-3 text-base leading-7 outline-none transition focus:border-[#2f8060] focus:ring-4 focus:ring-[#2f8060]/15"
                  placeholder={PLACEHOLDER}
                />
                <p className="text-xs leading-5 text-[#7a837c]">{WARNING_TEXT}</p>
              </div>

              {privacyRisks.length > 0 ? <PrivacyWarning labels={privacyRisks.map((risk) => risk.label)} /> : null}
              {errorMessage ? <StatusBox title="エラー" body={errorMessage} tone="error" /> : null}

              <button
                type="submit"
                disabled={isRunning || !question.trim() || privacyRisks.length > 0}
                className="block w-full max-w-full rounded-md bg-[#153b31] px-4 py-3 text-sm font-semibold text-white shadow-md transition hover:bg-[#0f2c24] disabled:cursor-not-allowed disabled:bg-[#8ca897]"
              >
                {isRunning ? "AIチームが検討中..." : "AIチームに相談する"}
              </button>
            </form>

            {isRunning ? <LoadingOutput providers={requestProviders} /> : null}
            {!isRunning && !result ? <EmptyOutput /> : null}
            {result ? (
              <>
                {showFinalAnswer ? <FinalAnswerCard result={result} /> : null}
                {!showFinalAnswer ? <ConsensusAction disabled={completedAnswers.length === 0} onClick={() => setShowFinalAnswer(true)} /> : null}
                <AnswerList answers={result.answers} />
              </>
            ) : null}
          </section>

          <aside className="min-w-0 space-y-4">
            {mode === "simple" ? <ProviderSummary mode={mode} providers={requestProviders} /> : <AdvancedSettingsPanel providers={allProviders} customKeys={customKeys} enabledCustomIds={enabledCustomIds} onToggle={(id) => {
              setEnabledCustomIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
              resetOutput();
            }} onChangeKey={(id, value) => {
              setCustomKeys((current) => ({ ...current, [id]: value }));
              resetOutput();
            }} />}
            <HistoryPanel entries={history} onOpen={openHistoryEntry} onClear={clearHistory} onToggleLock={toggleHistoryLock} />
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
    <div className="inline-grid w-full max-w-full grid-cols-2 gap-1 rounded-lg border border-white/15 bg-white/10 p-1 shadow-sm">
      <button
        type="button"
        onClick={() => onChange("simple")}
        className={`max-w-full rounded-md px-3 py-2 text-sm font-semibold transition ${mode === "simple" ? "bg-[#7edfc3] text-[#0f211d]" : "text-[#d8e9e3] hover:bg-white/10"}`}
      >
        簡単
      </button>
      <button
        type="button"
        onClick={() => onChange("advanced")}
        className={`max-w-full rounded-md px-3 py-2 text-sm font-semibold transition ${mode === "advanced" ? "bg-[#7edfc3] text-[#0f211d]" : "text-[#d8e9e3] hover:bg-white/10"}`}
        title={simpleRelayUrl ? "中継サーバーを使用中" : "ローカルAPIを使用中"}
      >
        詳細
      </button>
    </div>
  );
}

function StatusPill({ label, active }: { label: string; active: boolean }) {
  return (
    <span className={`max-w-full rounded-md border px-2 py-2 ${active ? "border-[#7edfc3]/60 bg-[#7edfc3]/15 text-[#dffbf2]" : "border-white/10 bg-white/5 text-[#91a69f]"}`}>
      <span className={`mr-2 inline-block h-2 w-2 rounded-full ${active ? "bg-[#7edfc3] shadow-[0_0_12px_rgba(126,223,195,0.9)]" : "bg-[#60756e]"}`} />
      {label}
    </span>
  );
}

function ProviderSummary({ mode, providers }: { mode: UsageMode; providers: ProviderConfig[] }) {
  return (
    <section className="max-w-full overflow-x-hidden rounded-lg border border-[#b9d4cc] bg-white p-4 shadow-md">
      <p className="text-sm font-semibold text-[#28614d]">{mode === "simple" ? "AIチーム" : "詳細AI設定"}</p>
      <p className="mt-1 text-xs leading-5 text-[#6b756d]">役割を分担して回答を検討します。</p>
      <div className="mt-3 grid gap-2">
        {providers.map((provider, index) => (
          <ProviderRow key={provider.id} provider={provider} showModel={mode === "advanced"} index={index} />
        ))}
      </div>
    </section>
  );
}

function ProviderRow({ provider, showModel, index }: { provider: ProviderConfig; showModel?: boolean; index: number }) {
  return (
    <div className="max-w-full overflow-x-hidden rounded-md border border-[#d7e4df] bg-[#fbfefd] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-[#2f8060]">Agent {index + 1}</p>
          <p className="break-words font-semibold text-[#243227]">{provider.name}</p>
          <p className="mt-1 break-words text-xs leading-5 text-[#6b756d]">{provider.role}</p>
          {showModel ? <p className="mt-1 break-words text-xs leading-5 text-[#6b756d]">{provider.model}</p> : null}
        </div>
        <span className={`max-w-[10rem] shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${provider.hasApiKey === false ? "bg-[#fff1ef] text-[#8a312a]" : "bg-[#eef5ef] text-[#2f6b49]"}`}>
          {provider.origin === "built-in" ? "中継" : provider.hasApiKey ? "有効" : "キー未入力"}
        </span>
      </div>
    </div>
  );
}

function HistoryPanel({
  entries,
  onOpen,
  onClear,
  onToggleLock,
}: {
  entries: HistoryEntry[];
  onOpen: (entry: HistoryEntry) => void;
  onClear: () => void;
  onToggleLock: (id: string) => void;
}) {
  return (
    <section className="max-w-full overflow-x-hidden rounded-lg border border-[#d6ddd4] bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[#4f6f56]">履歴</p>
          <p className="mt-1 break-words text-xs text-[#6b756d]">端末内に最大{HISTORY_LIMIT}件保存。開くとAPIを消費しません。</p>
        </div>
        {entries.length > 0 ? (
          <button type="button" onClick={onClear} className="max-w-full shrink-0 rounded-md bg-[#eef1ee] px-2 py-1 text-xs font-semibold text-[#34443a]">
            通常削除
          </button>
        ) : null}
      </div>
      {entries.length === 0 ? (
        <p className="mt-3 text-xs leading-5 text-[#7a837c]">まだ履歴はありません。</p>
      ) : (
        <div className="mt-3 grid gap-2">
          {entries.map((entry) => {
            const completedCount = entry.result.answers.filter((answer) => answer.status === "complete").length;
            return (
            <div key={entry.id} className="max-w-full overflow-x-hidden rounded-md border border-[#e2e7e3] bg-[#fbfcfa] p-2">
                <button type="button" onClick={() => onOpen(entry)} className="block w-full max-w-full rounded-md p-1 text-left transition hover:bg-[#eef5ef]">
                  <span className="block break-words text-sm font-semibold text-[#243227]">{entry.question}</span>
                  <span className="mt-1 block break-words text-xs leading-5 text-[#4f5c54]">{entry.result.conclusion.recommendation}</span>
                  <span className="mt-2 flex max-w-full flex-wrap gap-1 text-[11px] font-semibold text-[#2f6b49]">
                    <span className="max-w-full rounded bg-[#e8f4ef] px-2 py-1">最終結論</span>
                    <span className="max-w-full rounded bg-[#e8f4ef] px-2 py-1">AI会議ログ {completedCount}件</span>
                  </span>
                  <span className="mt-2 block text-xs text-[#6b756d]">{formatHistoryDate(entry.generatedAt)}</span>
                </button>
                <div className="mt-2 flex max-w-full flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onOpen(entry)}
                    className="max-w-full rounded-md bg-[#153b31] px-2 py-1 text-xs font-semibold text-white"
                  >
                    履歴を開く
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleLock(entry.id)}
                    className={`max-w-full rounded-md px-2 py-1 text-xs font-semibold ${entry.locked ? "bg-[#245f41] text-white" : "bg-[#eef1ee] text-[#34443a]"}`}
                  >
                    {entry.locked ? "保存中" : "保存"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function EmptyOutput() {
  return (
    <section className="max-w-full overflow-x-hidden rounded-lg border border-dashed border-[#9fc9bd] bg-white/70 p-6 text-center">
      <p className="text-sm font-semibold text-[#28614d]">AIチームは待機中です。</p>
      <p className="mt-2 text-sm leading-6 text-[#4b5a50]">質問を送ると、各AIの視点と合議結果がここに表示されます。</p>
    </section>
  );
}

function LoadingOutput({ providers }: { providers: ProviderConfig[] }) {
  return (
    <section className="max-w-full overflow-x-hidden rounded-lg border border-[#86b9aa] bg-[#10211d] p-5 text-white shadow-lg">
      <p className="text-sm font-semibold text-[#7edfc3]">AIチーム稼働中</p>
      <h2 className="mt-1 text-xl font-bold">回答を生成しています</h2>
      <div className="mt-4 grid gap-2">
        {providers.map((provider, index) => (
          <div key={provider.id} className="flex max-w-full items-center justify-between gap-3 rounded-md border border-white/10 bg-white/8 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 break-words font-semibold text-[#edf7f4]">{provider.name}</span>
            <span className="flex max-w-full items-center gap-2 break-words text-[#a9f2dd]">
              <span className="ai-pulse-dot" style={{ animationDelay: `${index * 120}ms` }} />
              {providerActionLabel(provider)}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs leading-5 text-[#b7cbc4]">回答取得後、成功したAIだけを使って合議します。</p>
    </section>
  );
}

function AnswerList({ answers }: { answers: AnalysisResult["answers"] }) {
  const completed = answers.filter((answer) => answer.status === "complete");
  const failed = answers.filter((answer) => answer.status === "error");
  const visibleAnswers = completed.length > 0 ? completed : answers;

  return (
    <details className="max-w-full overflow-x-hidden rounded-lg border border-[#b9d4cc] bg-white p-4 shadow-md">
      <summary className="cursor-pointer text-sm font-bold text-[#28614d]">AIの議論を見る</summary>
      <div className="mt-4 space-y-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[#4f6f56]">AI会議ログ</p>
          <h2 className="mt-1 text-xl font-bold text-[#17211b]">各AIの長文回答</h2>
        </div>
        {failed.length > 0 && completed.length > 0 ? <SkippedProvidersNotice count={failed.length} /> : null}
        <div className="grid gap-3">
          {visibleAnswers.map((answer) => (
            <article key={answer.id} className="max-w-full overflow-x-hidden rounded-lg border border-[#d6ddd4] bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-lg font-bold text-[#17211b]">{answer.name}</h3>
                  <p className="mt-1 break-words text-xs font-semibold text-[#6b756d]">{answer.status === "error" ? "エラー" : answer.costLabel}</p>
                </div>
                <span className={`max-w-[7rem] shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${answer.status === "error" ? "bg-[#fff1ef] text-[#8a312a]" : "bg-[#f1f4f2] text-[#2f6b49]"}`}>
                  {answer.status === "error" ? "失敗" : `${answer.confidence}%`}
                </span>
              </div>
              <p className="mt-3 whitespace-pre-line break-words text-sm leading-6 text-[#4b5a50]">{answer.summary}</p>
              <ul className="mt-4 space-y-2">
                {answer.bullets.map((bullet) => (
                  <li key={bullet} className="break-words rounded-md bg-[#f8faf7] px-3 py-2 text-sm leading-6 text-[#34443a]">
                    {bullet}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </details>
  );
}

function SkippedProvidersNotice({ count }: { count: number }) {
  return (
    <div className="max-w-full overflow-x-hidden rounded-md border border-[#e3c46f] bg-[#fff8df] px-3 py-2 text-xs leading-5 text-[#5c4a12]">
      {count}件のAIは混雑または一時的な制限のためスキップしました。取得できた回答だけで結果をまとめています。
    </div>
  );
}

function providerActionLabel(provider: ProviderConfig) {
  if (provider.id === "gemini-free") return "知識を整理中";
  if (provider.id === "openrouter-free" || provider.id === "openrouter") return "補足意見を生成中";
  if (provider.id === "qwen-free") return "実装視点で検証中";
  if (provider.id === "grok") return "反対視点を生成中";
  if (provider.id === "anthropic") return "論点を確認中";
  if (provider.id === "openai") return "回答を設計中";
  return "処理中";
}

function ConsensusAction({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="block w-full max-w-full rounded-lg border border-[#7edfc3]/40 bg-[#10211d] px-4 py-4 text-sm font-bold text-white shadow-lg transition hover:bg-[#153b31] disabled:cursor-not-allowed disabled:bg-[#8ca897]"
    >
      AI会議で最終結論を生成する
    </button>
  );
}

function FinalAnswerCard({ result }: { result: AnalysisResult }) {
  return (
    <section className="max-w-full overflow-x-hidden rounded-lg border border-[#79cdb6] bg-[#e8f8f3] p-5 shadow-lg">
      <p className="text-sm font-semibold text-[#2f8060]">AI Council Result</p>
      <h2 className="mt-1 text-2xl font-bold text-[#10211d]">最終結論</h2>
      {result.conclusion.safetyNote ? <StatusBox title="注意" body={result.conclusion.safetyNote} tone="warning" /> : null}
      <div className="mt-4 grid max-w-full gap-3">
        <ConclusionBlock title="結論" body={result.conclusion.recommendation} strong />
        <ConclusionBlock title="採用理由" body={result.conclusion.reason} />
        <ConclusionList title="AI同士の評価" items={result.conclusion.alternatives} />
        <ConclusionList title="不採用・補足理由" items={result.conclusion.cautions} />
      </div>
    </section>
  );
}

function AdvancedSettingsPanel({
  providers,
  customKeys,
  enabledCustomIds,
  onToggle,
  onChangeKey,
}: {
  providers: ProviderConfig[];
  customKeys: Record<string, string>;
  enabledCustomIds: string[];
  onToggle: (id: string) => void;
  onChangeKey: (id: string, value: string) => void;
}) {
  return (
    <details className="max-w-full overflow-x-hidden rounded-lg border border-[#d6ddd4] bg-white p-4 shadow-sm">
      <summary className="cursor-pointer text-sm font-semibold text-[#243227]">詳細設定（AIプロバイダ / APIキー）</summary>
      <p className="mt-2 text-xs leading-5 text-[#6b756d]">普段は閉じたまま使えます。必要なAIだけ有効化して、APIキーを入れてください。</p>
      <div className="mt-4 grid gap-4">
        <section className="grid gap-2">
          <p className="text-xs font-semibold text-[#4f6f56]">使用するAI</p>
          <div className="grid gap-2">
            {providers.filter((provider) => provider.origin === "custom").map((provider, index) => {
              const selected = enabledCustomIds.includes(provider.id);
              const hasApiKey = Boolean(customKeys[provider.id]?.trim());
              return (
                <div key={provider.id} className="max-w-full overflow-x-hidden rounded-md border border-[#d6ddd4] bg-[#fbfcfa] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-[#2f8060]">Agent {index + 1}</p>
                      <p className="break-words font-semibold text-[#243227]">{provider.name}</p>
                      <p className="mt-1 break-words text-xs leading-5 text-[#6b756d]">{provider.role}</p>
                    </div>
                    <button type="button" onClick={() => onToggle(provider.id)} className={`max-w-full shrink-0 rounded-md px-3 py-2 text-xs font-semibold ${selected ? "bg-[#245f41] text-white" : "bg-[#e8ece9] text-[#34443a]"}`}>
                      {selected ? "有効" : "無効"}
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-[#6b756d]">{hasApiKey ? "キー入力済み" : "キー未入力"}</p>
                  <label className="mt-3 block text-xs font-semibold text-[#34443a]" htmlFor={`key-${provider.id}`}>
                    APIキー
                  </label>
                  <input
                    id={`key-${provider.id}`}
                    type="password"
                    value={customKeys[provider.id] ?? ""}
                    onChange={(event) => onChangeKey(provider.id, event.target.value)}
                    placeholder="API key"
                    className="mt-2 w-full max-w-full rounded-md border border-[#c6cec8] bg-white px-3 py-2 text-sm outline-none transition focus:border-[#2f6b49] focus:ring-4 focus:ring-[#2f6b49]/15"
                  />
                </div>
              );
            })}
          </div>
        </section>
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
      <p className={`mt-2 whitespace-pre-line text-sm leading-7 ${strong ? "font-semibold text-[#17211b]" : "text-[#34443a]"}`}>{body}</p>
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

function loadHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryEntry[];
    return Array.isArray(parsed) ? trimHistory(parsed) : [];
  } catch {
    return [];
  }
}

function persistHistory(entries: HistoryEntry[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(trimHistory(entries)));
}

function trimHistory(entries: HistoryEntry[]) {
  const locked = entries.filter((entry) => entry.locked);
  const unlocked = entries.filter((entry) => !entry.locked).slice(0, Math.max(0, HISTORY_LIMIT - locked.length));
  return [...locked, ...unlocked].sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());
}

function formatHistoryDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
