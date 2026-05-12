# UI_REVISION_INSTRUCTIONS

This file is an additional instruction document for Codex.

Important:
- This file is saved as UTF-8.
- If Japanese text becomes garbled, set your editor and terminal encoding to UTF-8.
- If the file looks incomplete, reload the whole file.
- Prioritize a working MVP over a perfect implementation.
- Do not break existing API logic unless necessary.

---

# Project name

複数AIアンサー

English label:

Multiple AI Answer

---

# 1. Current problems

The app already has a working shape, but the current UI has several issues.

## 1.1 Category selection is unnecessary for MVP

Current categories such as:

- 開発
- 生活
- 健康・食事
- ビジネス
- 学習

may make users think they can only ask questions inside these categories.

For the MVP, remove category selection.

## 1.2 Example question buttons are unnecessary

The example question buttons under the textarea take space and make the UI less clear.

Remove these buttons.

Instead, use only one placeholder inside the question textarea:

```text
例：このWebアプリの改善点を教えて
```

## 1.3 The warning text should be shorter

Use this warning under the question textarea:

```text
※ APIキー・パスワードなどの機密情報は入力しないでください。
```

Keep it small and subtle.

## 1.4 The current UI feels like an API management page

The app should not feel like an API key management tool.

The main value of the app is:

```text
Question -> Multiple AI answers -> AI consensus -> Final answer
```

So the question and result flow should be the center of the UI.

---

# 2. Core concept

The core concept of this app is:

```text
Ask multiple AIs at once, compare their answers, and generate one final best answer.
```

Japanese:

```text
複数のAIに一度で質問し、各AIの回答を比較した上で、最後に最適な答えを1つにまとめる。
```

The important flow is:

1. User asks one question.
2. Multiple AIs answer independently.
3. The app compares and integrates those answers.
4. The app shows one final best answer.

---

# 3. Overall page structure

Use this order:

```text
複数AIアンサー
複数のAIに一度で質問し、最後に最適な答えをまとめます。

[簡単 / 詳細 mode switch]

[Question textarea]
※ APIキー・パスワードなどの機密情報は入力しないでください。

[複数AIに質問する]

[AI answer cards]

[AI合議で最適解を出す]

[Final answer card]

[Advanced settings if needed]
```

---

# 4. Simple mode

Simple mode is for normal users.

It should be easy to use without thinking about API keys.

## 4.1 Show in simple mode

Show mainly:

- App name
- Short description
- Question textarea
- Warning text
- Ask button
- AI answer cards
- AI consensus button
- Final answer card

## 4.2 Hide in simple mode

Hide or collapse:

- Category selection
- Example question buttons
- Statistics cards
- Detailed AI setting cards
- API key inputs
- Duplicate provider lists

## 4.3 Simple mode description

Use this description:

```text
複数のAIに一度で質問し、最後に最適な答えをまとめます。
```

## 4.4 Button labels

Ask button:

```text
複数AIに質問する
```

Consensus button:

```text
AI合議で最適解を出す
```

## 4.5 Simple mode AI providers

Simple mode should use the current relay server providers.

Examples:

- Gemini Free
- OpenRouter Free
- Qwen Free

Do not make technical model names too prominent in the main UI.

---

# 5. Detailed mode

Detailed mode is for users who want to use their own API keys.

However, detailed mode should still focus on asking questions, not managing API keys.

## 5.1 Detailed mode layout

Use this order:

```text
Question textarea
↓
Simple AI provider selection
↓
Ask multiple AIs
↓
AI answer cards
↓
AI consensus
↓
Final answer
↓
Advanced API key settings
```

## 5.2 Collapse API key settings

Do not show all API key input fields at the top.

Put them inside a collapsed section:

```text
詳細設定（APIキー）
```

Inside this section, include API key inputs for:

- OpenAI
- Claude
- Gemini
- DeepSeek
- OpenRouter

## 5.3 Enable / disable display

The current 有効 / 無効 display is acceptable.

But make it lighter if possible.

Example:

```text
☑ OpenAI
☑ Claude
☐ Gemini
☐ DeepSeek
☐ OpenRouter
```

Card UI is also acceptable if it does not make the page too heavy.

## 5.4 Detailed mode description

Use this text:

```text
入力したAPIキーを使って、選択したAIに直接問い合わせます。
```

## 5.5 API key missing behavior

If an API key is missing, exclude that provider from request targets.

Show:

```text
キー未入力
```

for providers without keys.

---

# 6. AI consensus feature

This feature is the core of the app.

## 6.1 Purpose

Do not only list multiple AI answers.

After the AI answers are generated, allow the user to integrate them into one best final answer.

## 6.2 When to show the button

Show the consensus button after at least one AI answer is available.

Button:

```text
AI合議で最適解を出す
```

## 6.3 Final answer heading

Use one of these headings:

```text
最終回答
```

or:

```text
AI合議による最適解
```

## 6.4 Consensus prompt idea

Use a prompt like this internally:

```text
以下は複数AIの回答です。
共通点、相違点、実用性を比較し、ユーザーにとって最も役立つ最終回答を1つにまとめてください。
必要なら、採用すべき案と注意点も整理してください。
```

English meaning:

```text
Below are answers from multiple AIs.
Compare common points, differences, and practicality.
Create one final answer that is most useful to the user.
If necessary, organize the recommended plan and cautions.
```

---

# 7. Result display

## 7.1 AI answer cards

Show each AI answer in a card.

Example:

```text
[Gemini]
answer text...

[OpenRouter]
answer text...

[Qwen]
answer text...
```

## 7.2 Final answer card

The final answer card should be more visually important than individual AI answer cards.

Heading:

```text
AI合議による最適解
```

## 7.3 Empty state text

Use a simple empty state:

```text
質問すると、複数AIの回答がここに表示されます。
```

---

# 8. Design direction

## 8.1 Overall

- Add more whitespace.
- Reduce the number of visible cards.
- Make the question textarea the main element.
- Make the first action obvious.
- Optimize for smartphone screens.

## 8.2 Colors

The current green theme is good and can remain.

But use strong green mainly for important actions and selected states.

## 8.3 Main buttons

The two most important buttons are:

1. 複数AIに質問する
2. AI合議で最適解を出す

Make these two buttons visually clear.

---

# 9. Remove or reduce

Remove or collapse:

- Category selection
- Example question buttons
- Top statistics cards
- Duplicate provider list
- Always-visible API key inputs
- Excessive explanations

---

# 10. Target user experience

The user should feel:

```text
I ask once.
Multiple AIs think.
Then I can press AI consensus and get one final answer.
```

Japanese:

```text
1回質問するだけで、複数AIが考えてくれる。
さらにAI合議ボタンを押すと、それらの意見をまとめた最終回答が出る。
```

---

# 11. Implementation priority

Implement in this order:

1. Remove category selection.
2. Remove example question buttons.
3. Make the question textarea the center of the UI.
4. Clean up simple mode.
5. Collapse API key settings in detailed mode.
6. Add AI consensus button.
7. Add final answer card.
8. Improve spacing and mobile readability.

---

# 12. Completion criteria

The task is complete when:

- Simple mode is easy to use without confusion.
- Detailed mode still keeps the question textarea as the main element.
- Category selection is removed.
- Example question buttons are removed.
- Warning text is short.
- AI answer cards are shown after asking.
- The AI consensus button appears after AI answers are available.
- The final answer is clearly displayed.
- The page is readable on smartphone screens.
- Existing API connection logic is preserved as much as possible.

---

# 13. Most important direction

This app is not an API key management tool.

This app is:

```text
A tool for asking multiple AIs and getting one final best answer.
```

Japanese:

```text
複数AIに質問して、最終回答を得るアプリ。
```

Prioritize the question and answer experience over settings.
