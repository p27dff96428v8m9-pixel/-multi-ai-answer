# AI Key Architecture

Date: 2026-05-12

This app uses two operating modes.

## Simple Mode

Simple mode is for users who do not have API keys.

Flow:

```text
Android app / Web app
  -> simple relay server
  -> Gemini / OpenRouter / other low-cost models
```

Rules:

- Provider API keys must stay on the relay server.
- Do not embed provider API keys in the APK.
- The relay server should enforce daily request limits, question length limits, and provider/model restrictions.
- The app should call the relay through `NEXT_PUBLIC_SIMPLE_RELAY_URL` when configured.
- During local development, the app can fall back to the local Next.js API route.

## Advanced Mode

Advanced mode is BYOK: Bring Your Own Key.

Flow:

```text
Android app / Web app
  -> provider API directly with the user's key
```

Rules:

- The user supplies their own API key.
- The key is sent only to the selected provider.
- The app should not send advanced-mode user keys to the simple relay server.
- If key persistence is added later on Android, use secure device storage instead of plain local storage.

## Practical Notes

- APK-embedded provider keys are considered extractable.
- Obfuscation can slow extraction but cannot protect keys reliably.
- A public app should use a relay server for built-in/simple usage.
- BYOK is acceptable for advanced users because the user owns the key and cost.

