const form = document.querySelector("#askForm");
const question = document.querySelector("#question");
const statusEl = document.querySelector("#status");
const submitButton = document.querySelector("#submitButton");
const finalAnswer = document.querySelector("#finalAnswer");
const mergedBy = document.querySelector("#mergedBy");
const responsesEl = document.querySelector("#responses");
const saveKeys = document.querySelector("#saveKeys");
const mergeProvider = document.querySelector("#mergeProvider");

const fields = {
  openai: {
    key: document.querySelector("#openaiKey"),
    model: document.querySelector("#openaiModel")
  },
  anthropic: {
    key: document.querySelector("#anthropicKey"),
    model: document.querySelector("#anthropicModel")
  },
  gemini: {
    key: document.querySelector("#geminiKey"),
    model: document.querySelector("#geminiModel")
  }
};

const providerNames = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  local: "ローカル整理"
};

loadSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  setStatus("問い合わせ中");
  finalAnswer.classList.remove("empty");
  finalAnswer.textContent = "各AIへ問い合わせています...";
  mergedBy.textContent = "";
  responsesEl.innerHTML = "";

  const providers = [...document.querySelectorAll('input[name="provider"]:checked')].map((input) => input.value);
  const payload = {
    question: question.value.trim(),
    providers,
    mergeProvider: mergeProvider.value,
    keys: {
      openai: fields.openai.key.value.trim(),
      anthropic: fields.anthropic.key.value.trim(),
      gemini: fields.gemini.key.value.trim()
    },
    models: {
      openai: fields.openai.model.value.trim(),
      anthropic: fields.anthropic.model.value.trim(),
      gemini: fields.gemini.model.value.trim()
    }
  };

  try {
    persistSettings();
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "実行に失敗しました。");
    }

    finalAnswer.textContent = data.finalAnswer || "(空の回答)";
    mergedBy.textContent = `統合: ${providerNames[data.mergedBy] || data.mergedBy}`;
    renderResponses(data.responses || []);
    setStatus(data.mergeError ? "一部失敗" : "完了");
  } catch (error) {
    finalAnswer.textContent = error.message || "実行に失敗しました。";
    mergedBy.textContent = "";
    setStatus("エラー");
  } finally {
    setBusy(false);
  }
});

function renderResponses(responses) {
  if (responses.length === 0) {
    responsesEl.innerHTML = '<p class="answer empty">回答はありません。</p>';
    return;
  }

  responsesEl.innerHTML = responses
    .map((response) => {
      const stateClass = response.ok ? "response-ok" : "response-error";
      const stateText = response.ok ? "成功" : "失敗";
      const text = response.ok ? response.text : response.error;
      return `
        <article class="response-card">
          <div class="response-meta">
            <span class="response-title">${escapeHtml(response.label)} / ${escapeHtml(response.model || "")}</span>
            <span class="${stateClass}">${stateText} ${Number(response.durationMs || 0)}ms</span>
          </div>
          <div class="response-text">${escapeHtml(text || "")}</div>
        </article>
      `;
    })
    .join("");
}

function setBusy(isBusy) {
  submitButton.disabled = isBusy;
  submitButton.textContent = isBusy ? "実行中" : "実行";
}

function setStatus(text) {
  statusEl.textContent = text;
}

function persistSettings() {
  const settings = {
    saveKeys: saveKeys.checked,
    mergeProvider: mergeProvider.value,
    models: {
      openai: fields.openai.model.value,
      anthropic: fields.anthropic.model.value,
      gemini: fields.gemini.model.value
    },
    keys: saveKeys.checked
      ? {
          openai: fields.openai.key.value,
          anthropic: fields.anthropic.key.value,
          gemini: fields.gemini.key.value
        }
      : {}
  };
  localStorage.setItem("multi-ai-answer-settings", JSON.stringify(settings));
}

function loadSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem("multi-ai-answer-settings") || "{}");
    saveKeys.checked = Boolean(settings.saveKeys);
    mergeProvider.value = settings.mergeProvider || "auto";
    for (const provider of Object.keys(fields)) {
      if (settings.models?.[provider]) fields[provider].model.value = settings.models[provider];
      if (settings.saveKeys && settings.keys?.[provider]) fields[provider].key.value = settings.keys[provider];
    }
  } catch {
    localStorage.removeItem("multi-ai-answer-settings");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
