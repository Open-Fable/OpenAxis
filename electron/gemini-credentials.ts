// Gemini CLI "installed app" OAuth credentials.
//
// These identify the APPLICATION to Google — they are NOT personal user data.
// They are the public values published by upstream gemini-cli (Google documents
// that an installed-app "client secret" is not confidential). Each end user still
// logs in with their own Google account; their refresh token stays local in
// ~/.local/share/opencode/auth.json and is never bundled.
//
// Shipping them in source is therefore safe and makes the packaged build work for
// everyone out of the box. Both can be overridden via env vars (e.g. an .env
// loaded in dev, or your own OAuth client); an empty/unset env falls back to the
// public default.
export const GEMINI_CLIENT_ID =
  process.env.GEMINI_CLIENT_ID ||
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";

export const GEMINI_CLIENT_SECRET =
  process.env.GEMINI_CLIENT_SECRET || "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";
