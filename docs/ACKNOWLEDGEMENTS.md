**English** · [Français](ACKNOWLEDGEMENTS.fr.md)

# Acknowledgements

OpenAxis is a **shell**, not a fork. It does not contain, modify, or redistribute the
source code of the tools it unifies — those projects are **cloned at install time** by
`scripts/setup.sh` into the (git-ignored) `apps/` directory and run as independent
native processes. All credit for the actual AI tooling belongs to their authors.

## The tools OpenAxis unifies

| Tool                                                  | Author       | License        | Role in OpenAxis            |
| ----------------------------------------------------- | ------------ | -------------- | --------------------------- |
| [OpenCode](https://github.com/sst/opencode)           | sst          | MIT            | Code agent (Code slot)      |
| [OpenWork](https://github.com/different-ai/openwork)  | different-ai | see upstream\* | Orchestration (Work slot)   |
| [Open Design](https://github.com/nexu-io/open-design) | nexu-io      | Apache-2.0     | Visual design (Design slot) |

\* At the time of writing, OpenWork does not expose a standard SPDX license on GitHub.
Please review its repository for the current terms before relying on it. OpenAxis does
not redistribute OpenWork's code — it clones it from the upstream repository on your
machine.

Because OpenAxis fetches these projects at runtime rather than bundling them, it imposes
no additional license terms on them: each tool remains governed solely by its own
license. If you redistribute any of these tools yourself, follow their respective
license requirements (e.g. Apache-2.0 requires preserving the `NOTICE` and attribution).

## What is OpenAxis's own code?

Everything under `electron/`, `scripts/`, `config/`, `docs/`, and the repository's
configuration — the Electron shell, the LLM proxy, the override system, the multi-agent
orchestrator, and the documentation — is OpenAxis's own work, released under the
[MIT License](../LICENSE).

## Also built with

- [Electron](https://www.electronjs.org) — desktop runtime
- [Express](https://expressjs.com) — the local LLM proxy
- [keytar](https://github.com/atom/node-keytar) — encrypted secret storage (AES-256-GCM)
- [Vitest](https://vitest.dev) and [Playwright](https://playwright.dev) — testing

Thank you to the maintainers of these projects.
