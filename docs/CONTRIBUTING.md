**English** · [Français](CONTRIBUTING.fr.md)

# Contributing to OpenAxis

Thanks for wanting to contribute! Here's how to get involved.

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md) — by participating, you are
expected to uphold it.

## Prerequisites

- macOS 14+
- Node.js 22+
- Git

## Local setup

```bash
git clone https://github.com/Open-Fable/OpenAxis.git
cd OpenAxis
bash scripts/setup.sh
npm run dev
```

## Workflow

1. **Fork** the repo and create a branch from `main`
2. **Install** dependencies with `bash scripts/setup.sh`
3. **Make your changes** — touch only what's necessary
4. **Verify**: `npm run typecheck && npm run lint && npm test`
5. **Test** manually in Electron (`npm run dev`)
6. **Open a PR** with a clear description

## Rules

- **Never modify the upstream apps' source code** (`apps/`). All customization goes through `electron/overrides/`.
- **No secrets in the code.** API keys are stored in an encrypted file at `~/Library/Application Support/openaxis/secrets.enc` (AES-256-GCM).
- **Conventional commits:** `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
- **Strict TypeScript.** No `any` except at serialization boundaries.
- **Files < 400 lines, functions < 50 lines.**

## Reporting a bug

Use the [Bug Report](https://github.com/Open-Fable/OpenAxis/issues/new?template=bug_report.yml) template.

## Proposing a feature

Use the [Feature Request](https://github.com/Open-Fable/OpenAxis/issues/new?template=feature_request.yml) template.

## License

By contributing, you agree that your contributions are licensed under the [MIT](../LICENSE) license.
