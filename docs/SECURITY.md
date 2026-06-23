**English** · [Français](SECURITY.fr.md)

# Security

## Threat Model

OpenAxis is a local macOS desktop app. It runs entirely on your machine — no cloud backend, no telemetry.

### What is protected

| Surface                | How                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **API keys**           | Stored in an encrypted file at `~/Library/Application Support/openaxis/secrets.enc` (AES-256-GCM) — never written to environment variables |
| **LLM proxy**          | Binds to `127.0.0.1:9999` only — not accessible from other machines. Requires a per-session Bearer token                                   |
| **WebViews**           | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` — upstream apps cannot access Node.js APIs                             |
| **Injected overrides** | CSS/JS only — no secrets are ever inlined in override files                                                                                |
| **LLM proxy token**    | Per-session token (`randomBytes(32)`), required on every route; no static/shared token; constant-time compared                             |
| **opencode server**    | Bound to `127.0.0.1` only — not reachable from other machines                                                                              |

### Out of scope

| Category                         | Rationale                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Upstream app vulnerabilities** | OpenWork, OpenCode, Open Design are independent projects — report to them directly                      |
| **LLM provider data handling**   | Governed by the provider's own policies (Anthropic, OpenAI, etc.)                                       |
| **Malicious config files**       | Users control their own `~/.config/openaxis/` — modifying it is not an attack vector                    |
| **Physical machine access**      | If an attacker has local access to your machine, the encrypted secrets file is protected by AES-256-GCM |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use the GitHub Security Advisory tab: [Report a Vulnerability](https://github.com/Open-Fable/OpenAxis/security/advisories/new)

Response within 5 business days. After the initial reply, you will be kept informed of progress toward a fix.

> [!NOTE]
> We do not accept AI-generated security reports. They will be closed without review.
