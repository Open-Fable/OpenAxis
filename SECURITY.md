# Security

## Threat Model

OpenHub is a local macOS desktop app. It runs entirely on your machine — no cloud backend, no telemetry.

### What is protected

| Surface                | How                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| **API keys**           | Stored in macOS Keychain via `keytar` — never written to disk or environment variables                         |
| **LLM proxy**          | Binds to `127.0.0.1:9999` only — not accessible from other machines. Requires a per-session Bearer token       |
| **WebViews**           | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` — upstream apps cannot access Node.js APIs |
| **Injected overrides** | CSS/JS only — no secrets are ever inlined in override files                                                    |
| **LLM proxy token**    | Per-session token (`randomBytes(32)`), required on every route; no static/shared token; constant-time compared |
| **opencode server**    | Bound to `127.0.0.1` only — not reachable from other machines                                                  |

### Out of scope

| Category                         | Rationale                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Upstream app vulnerabilities** | OpenWork, OpenCode, Open Design are independent projects — report to them directly               |
| **LLM provider data handling**   | Governed by the provider's own policies (Anthropic, OpenAI, etc.)                                |
| **Malicious config files**       | Users control their own `~/.config/openhub/` — modifying it is not an attack vector              |
| **Physical machine access**      | If an attacker has local access to your machine, macOS Keychain protects secrets at the OS level |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use the GitHub Security Advisory tab: [Report a Vulnerability](https://github.com/1zalt/OpenHub/security/advisories/new)

Response within 5 business days. After the initial reply, you will be kept informed of progress toward a fix.

> [!NOTE]
> We do not accept AI-generated security reports. They will be closed without review.
