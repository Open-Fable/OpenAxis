# GitHub Repo Optimization

Run these commands to set up repo metadata for discoverability.

## Repository description

```bash
gh repo edit Open-Fable/OpenAxis --description "macOS AI workspace — chat, multi-agent orchestrator, code agent, design tool in one sidebar. Supports Anthropic, OpenAI, Ollama, Gemini. MIT."
```

## Topics (appear in GitHub Explore and search)

```bash
gh repo edit Open-Fable/OpenAxis --add-topic electron,macos,ai,llm,desktop-app,open-source,typescript,multi-agent,orchestrator,ollama,anthropic,openai,developer-tools,ai-tools,code-assistant
```

## Homepage URL (if you set up GitHub Pages)

```bash
gh repo edit Open-Fable/OpenAxis --homepage "https://open-fable.github.io/OpenAxis"
```

## Social preview image

Upload a 1280x640 image to Settings → Social preview. This is what shows up when
the repo is shared on Twitter, Discord, Slack, etc.

Suggested content:

- OpenAxis logo/icon on the left
- "Chat · Code · Design · Orchestrator" tagline
- Dark background matching the app theme
- Screenshot of the sidebar in the background (blurred)

## Pin the repo

Go to your GitHub profile → "Customize your pins" → add OpenAxis.

## Enable Discussions

Settings → Features → Discussions → Enable.
Create these categories:

- General (open discussion)
- Ideas (feature proposals from the community)
- Q&A (support)
- Show and Tell (users sharing what they built with OpenAxis)

## Enable Sponsors

Go to https://github.com/sponsors/Open-Fable/dashboard to set up GitHub Sponsors
(the FUNDING.yml is already created).
