# NEXT_STEPS_DEPLOY

最終更新: 2026-05-12

## 現在の状態

- UIの文字化けは修正済み。
- 簡単モード用に `.env.local` を作成済み。
- `.env.local` に `OPENROUTER_API_KEY` は入力済み。
- `GEMINI_API_KEY` は未入力。
- `NEXT_PUBLIC_SIMPLE_RELAY_URL` は未入力。
- `/api/ask` にCORS対応を追加済み。
- `.gitignore` を追加済み。`.env.local` はGitHubに上がらない設定。
- `npm run build` は成功済み。

## なぜ公開サーバーが必要か

Android APKにAPIキーを直接入れるのは危険。
そのため、簡単モードは次の構成にする。

```text
Androidアプリ
  -> 公開中継サーバー Next.js /api/ask
  -> OpenRouter API
```

## 次にやること

### 1. GitHubリポジトリを作る

GitHubで空のリポジトリを作成する。
例:

```text
multi-ai-answer
```

注意:

- `.env.local` は絶対にコミットしない。
- このプロジェクトには `.gitignore` 済み。

### 2. ローカルGit初期化とpush

プロジェクト:

```text
C:\Users\p27df\.gemini\複数AIアンサー
```

予定コマンド:

```powershell
git init
git add .
git commit -m "Initial multi AI answer app"
git branch -M main
git remote add origin <GitHub repo URL>
git push -u origin main
```

### 3. VercelへImport

VercelでGitHubリポジトリをImportする。

FrameworkはNext.js。

Build command:

```text
npm run build
```

### 4. Vercel環境変数

VercelのProject Settings -> Environment Variables に登録する。

必須:

```env
OPENROUTER_API_KEY=<OpenRouterのキー>
SIMPLE_PROVIDER_LIMIT=1
```

任意:

```env
OPENROUTER_FREE_MODEL=openrouter/auto
OPENROUTER_QWEN_MODEL=qwen/qwen3-14b:free
DAILY_SIMPLE_REQUEST_LIMIT=10
MAX_QUESTION_LENGTH=1200
```

Geminiも使うなら:

```env
GEMINI_API_KEY=<Geminiのキー>
GEMINI_MODEL=gemini-2.5-flash
```

### 5. Vercel公開URLを確認

例:

```text
https://multi-ai-answer.vercel.app
```

以下が動けばOK:

```text
https://multi-ai-answer.vercel.app/api/config
```

### 6. Android APKに公開URLを焼き込む

`.env.local` の以下を設定する。

```env
NEXT_PUBLIC_SIMPLE_RELAY_URL=https://multi-ai-answer.vercel.app
```

その後:

```powershell
npm run build:static
npm run android:sync:static
cd android
$env:JAVA_HOME='D:\JDK\jdk-21.0.11+10'
$env:Path="$env:JAVA_HOME\bin;$env:Path"
$env:GRADLE_USER_HOME='D:\GradleHome'
.\gradlew.bat assembleDebug --no-daemon
```

ADBインストール:

```powershell
& 'C:\Users\p27df\AppData\Local\Android\Sdk\platform-tools\adb.exe' kill-server
& 'C:\Users\p27df\AppData\Local\Android\Sdk\platform-tools\adb.exe' start-server
& 'C:\Users\p27df\AppData\Local\Android\Sdk\platform-tools\adb.exe' install -r 'C:\Users\p27df\.gemini\複数AIアンサー\android\app\build\outputs\apk\debug\app-debug.apk'
& 'C:\Users\p27df\AppData\Local\Android\Sdk\platform-tools\adb.exe' shell monkey -p com.multiai.answer -c android.intent.category.LAUNCHER 1
```

## 注意

- OpenRouterキーはチャットに貼らない。
- `.env.local` はGitHubに上げない。
- VercelにはEnvironment Variablesから登録する。
- クレジット未登録でもAPIキーは作れるが、実行時に残高不足エラーになる可能性がある。
