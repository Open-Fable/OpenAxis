import keytar from "keytar";

const SERVICE = "openhub";

export async function readSecret(
  service: string,
  account: string,
): Promise<string | null> {
  return keytar.getPassword(service, account);
}

export async function writeSecret(
  service: string,
  account: string,
  secret: string,
): Promise<void> {
  await keytar.setPassword(service, account, secret);
}

export async function deleteSecret(service: string, account: string): Promise<void> {
  await keytar.deletePassword(service, account);
}

export async function readAllApiKeys(): Promise<{
  anthropic: string | null;
  openai: string | null;
  openrouterKey: string | null;
  googleAiKey: string | null;
  githubToken: string | null;
  braveSearchKey: string | null;
  ollamaUrl: string;
}> {
  const [anthropic, openai, openrouterKey, googleAiKey, githubToken, braveSearchKey, ollamaUrl] =
    await Promise.all([
      keytar.getPassword(SERVICE, "anthropic-api-key"),
      keytar.getPassword(SERVICE, "openai-api-key"),
      keytar.getPassword(SERVICE, "openrouter-api-key"),
      keytar.getPassword(SERVICE, "google-ai-key"),
      keytar.getPassword(SERVICE, "github-token"),
      keytar.getPassword(SERVICE, "brave-search-key"),
      keytar.getPassword(SERVICE, "ollama-url"),
    ]);

  return {
    anthropic,
    openai,
    openrouterKey,
    googleAiKey,
    githubToken,
    braveSearchKey,
    ollamaUrl: ollamaUrl ?? "http://127.0.0.1:11434",
  };
}
