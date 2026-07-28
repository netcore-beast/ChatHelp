import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.chathelp.app",
  appName: "ChatHelp",
  webDir: "out",
  server: {
    androidScheme: "https",
    hostname: "app.chathelp.local",
    cleartext: false,
    allowNavigation: [],
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
  },
};

export default config;
