// Gemini OAuth — désactivé depuis le 18 juin 2026.
//
// L'authentification Google a été retirée. Les identifiants sont figés à
// une chaîne vide et les routes OAuth ne répondent plus. Aucun appel sortant
// vers les API Google Gemini n'est effectué par le proxy.
import fs from "fs";
import path from "path";
import os from "os";

function loadEnvSync() {
  const paths = [
    path.join(os.homedir(), ".config", "openaxis", ".env"),
    path.join(os.homedir(), "Documents", "Application", "OpenAxis", ".env"),
  ];

  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, "utf-8");
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const index = trimmed.indexOf("=");
          if (index === -1) continue;
          const key = trimmed.slice(0, index).trim();
          const val = trimmed
            .slice(index + 1)
            .trim()
            .replace(/^['"]|['"]$/g, "");
          if (key && !process.env[key]) {
            process.env[key] = val;
          }
        }
        break;
      }
    } catch {
      // ignore
    }
  }
}

loadEnvSync();

export const GEMINI_CLIENT_ID = "";
export const GEMINI_CLIENT_SECRET = "";
