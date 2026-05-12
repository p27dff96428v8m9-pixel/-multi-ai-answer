# AIマルチツール MVP

複数AIへ同じ質問を投げ、回答を比較統合し、最後に1つの結論へまとめるNext.js App Router版のMVPです。かんたんモードではサーバー側のAPIキーを使って、Gemini / OpenRouter系の実APIから回答を取得します。

## コンセプト

「AI版のマルチツール（万能工具）」として、ユーザーは1つの画面に質問するだけで、複数AIの意見と統合結論を確認できます。

一般ユーザーはAPIキー不要の「かんたんモード」で使い始め、詳しいユーザーは「詳細モード」で自分のAPIキーを追加して、OpenAI、Claude、DeepSeek、OpenRouterなどの意見を追加できる設計です。

## 機能

- 質問入力フォーム
- 開発、生活、健康・食事、ビジネス、学習の相談カテゴリ
- かんたんモード: Gemini Free / OpenRouter Free / Qwen Free を想定した組み込みAI
- 詳細モード: ユーザーAPIキーによる追加AI設定UI
- 複数AIへの並列問い合わせ
- Gemini / OpenRouter / OpenAI / Claude / DeepSeek のサーバー側API呼び出し
- 最終出力として「推奨案」「採用理由」「代替案」「注意点」を表示
- 健康・食事カテゴリでは医療注意書きを表示
- スマートフォンからデスクトップまでのレスポンシブUI

## 実API連携時の方針

- 組み込みAPIキーはフロントエンドに置かず、必ずサーバー側で呼び出す
- 無料枠は条件が変わるため、複数プロバイダーを切り替えられる設計にする
- 詳細モードのAPIキーはサーバー側で暗号化保存、または保存せずセッション利用にする
- Claudeなど有料APIは、ユーザー自身のAPIキーを入力した場合のみ利用する

## 無料枠保護

MVPではサーバー側のインメモリ制限で、無料API枠の使いすぎを防ぎます。

```text
DAILY_SIMPLE_REQUEST_LIMIT=10
DAILY_ADVANCED_REQUEST_LIMIT=30
MAX_QUESTION_LENGTH=1200
SIMPLE_PROVIDER_LIMIT=1
```

本番運用では、RedisやDBでユーザー/IP単位の利用回数を管理してください。

## 技術構成

- Next.js App Router
- TypeScript
- Tailwind CSS
- React

## セットアップ

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

起動後、ブラウザで以下を開きます。

```text
http://localhost:3000
```

`.env.local` には、最低でも以下のどちらかを設定してください。

```text
GEMINI_API_KEY=...
OPENROUTER_API_KEY=...
```

キーが未設定の場合、ダミー回答には戻さず、回答カードに設定不足のエラーを表示します。

## Androidアプリ化

このアプリはCapacitorでAndroid Studioから開ける構成にしています。

```powershell
npm run dev
npm run android:open
```

Androidエミュレーターでは、アプリ内WebViewが `http://10.0.2.2:3000` を開きます。これはエミュレーターから見たPC側のNext.jsサーバーです。

実機で確認する場合は、PCとスマホを同じWi-Fiに接続し、`CAPACITOR_SERVER_URL` をPCのLAN IPに変更して同期します。

```powershell
$env:CAPACITOR_SERVER_URL="http://192.168.x.x:3000"
npm run android:sync
npm run android:open
```

本番公開時は、Next.jsサーバーをHTTPSで公開し、`CAPACITOR_SERVER_URL` にそのURLを指定してAndroidビルドします。AI APIキーはAndroidアプリ内ではなく、必ずNext.jsサーバー側に置きます。

## ディレクトリ構成

```text
app/
  api/
    ask/
      route.ts
    config/
      route.ts
  globals.css
  layout.tsx
  page.tsx
android/
capacitor.config.ts
capacitor-www/
components/
  multi-ai-tool.tsx
lib/
  dummy-ai.ts
public/
  legacy-static/    # 以前の静的MVPを退避
SPEC.md
```

## 今後の拡張候補

- サーバー側の無料/低コストAIルーター
- BYOK方式のAPIキー保存
- 回答の一致点相違点の表示
- AIごとの重み付け
- コスト表示
- 会話履歴とプロジェクト別保存
- Codex CLI 連携
