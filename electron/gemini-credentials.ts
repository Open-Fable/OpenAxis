// Gemini CLI "installed app" OAuth credentials.
//
// These identify the APPLICATION to Google — they are NOT personal user data.
// They are the public values published by upstream gemini-cli (Google documents
// that an installed-app "client secret" is not confidential). Each end user still
// logs in with their own Google account; their refresh token stays local in
// ~/.local/share/opencode/auth.json and is never bundled.
//
// They are sourced ONLY from env vars (an .env loaded in dev, or your own OAuth
// client) — never hardcoded in source. When unset, both resolve to "" and the
// Gemini OAuth route is disabled (see gemini-oauth.ts / proxy/index.ts). Get the
// public values from the upstream gemini-cli project (see .env.example).
export const GEMINI_CLIENT_ID = process.env.GEMINI_CLIENT_ID || "";

export const GEMINI_CLIENT_SECRET = process.env.GEMINI_CLIENT_SECRET || "";
