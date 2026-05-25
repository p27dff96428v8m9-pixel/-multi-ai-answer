import type { CapacitorConfig } from "@capacitor/cli";

const serverUrl = process.env.CAPACITOR_SERVER_URL?.trim();

const config: CapacitorConfig = {
  appId: "com.multiai.answer",
  appName: "複数AIアンサー",
  webDir: process.env.CAPACITOR_WEB_DIR || (process.env.CAPACITOR_STATIC === "1" ? "out" : "capacitor-www"),
  ...(serverUrl
    ? {
        server: {
          url: serverUrl,
          cleartext: true,
          androidScheme: "https",
        },
      }
    : {}),
  plugins: {
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: "#0f211d",
      showSpinner: false,
    },
  },
};

export default config;
