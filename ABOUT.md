<div align="center">

<img src="media/icon.svg" width="80" height="80" alt="OllamaUnofficial Logo" />

# OllamaUnofficial

<p align="center">
  <a href="README.md">📖 README</a> &nbsp;|&nbsp;
  <a href="ABOUT.md"><b>💡 About</b></a> &nbsp;|&nbsp;
  <a href="CONTRIB.md">🤝 Contributing</a> &nbsp;|&nbsp;
  <a href="https://github.com/Spiritbocs/OllamaUnofficial/issues">🐛 Issues</a> &nbsp;|&nbsp;
  <a href="https://discord.gg/gV7FzbrJCu">💬 Discord</a>
</p>

</div>

---

## What is OllamaUnofficial?

OllamaUnofficial is a VS Code extension built on one belief: **great AI tools should be free.**

The AI coding assistant market is flooded with paywalls. GitHub Copilot, Cursor, Codeium Pro — the good stuff costs money, and the free tiers are deliberately crippled to push you toward a subscription. OllamaUnofficial takes a different approach entirely. It connects directly to three of the most powerful free AI ecosystems in the world and brings them into your editor as a first-class coding assistant.

No subscriptions. No usage limits that matter. No telemetry. Just you and the model.

---

## The Problem We're Solving

Most developers know AI can make them dramatically more productive — but most developers also don't want to pay $20/month for a tool that might not stick. And the models available on free tiers are often months behind, rate-limited to the point of uselessness, or missing the features that actually matter (like reading your files, running commands, or understanding your codebase).

OllamaUnofficial gives you access to the **exact same models** that power premium tools — DeepSeek-R1, Llama 3.3, Qwen 2.5 Coder, Gemini Flash, and more — without paying a cent.

---

## How It Works

OllamaUnofficial is a VS Code sidebar extension that acts as a universal front-end for three AI backends:

### 🦙 Ollama — Your Local AI
Ollama lets you run large language models directly on your computer. No cloud. No API key. No data ever leaving your machine. OllamaUnofficial detects Ollama on startup, checks if it's running, and offers to start it if it isn't. Pull any model from Ollama's library and it shows up instantly in the extension.

This is the option for developers who care about privacy, work offline, or just don't want to depend on anyone else's servers.

### 🔀 OpenRouter — The Free Model Marketplace
OpenRouter aggregates hundreds of AI models under a single API, and many of them are completely free. We're talking `deepseek/deepseek-r1:free`, `meta-llama/llama-3.3-70b-instruct:free`, `google/gemini-2.0-flash-exp:free` — models that compete with or beat GPT-4 on most benchmarks, available at zero cost. You create a free account, get an API key, paste it in, and you're done.

### 🤗 Hugging Face — The Open Model Hub
Hugging Face hosts over a million open models and provides an Inference API that lets you run many of them for free. OllamaUnofficial plugs straight into it. Create a free account, generate a token with Inference Providers permission, and you unlock thousands of models including Qwen 2.5, DeepSeek distills, Mistral, and more.

---

## What It Can Do

OllamaUnofficial isn't just a chat box. It's a full coding assistant:

- **Read and edit your files** — attach any file for context, or let the AI apply code changes directly to your workspace
- **Run terminal commands** — the AI can execute shell commands in VS Code's integrated terminal
- **Understand your git repo** — view diffs, write commit messages, commit and push, all from the chat
- **Browse the web** — open any webpage inside VS Code, select text or click on elements, and send them to the chat instantly
- **Multi-session tabs** — run multiple independent conversations side by side
- **Reasoning model support** — models like DeepSeek-R1 that "think out loud" show a collapsible reasoning block so the response stays clean

---

## Who It's For

- **Students and hobbyists** who want AI assistance without a monthly bill
- **Professional developers** who want a private, offline alternative to cloud AI tools
- **Open source contributors** who want capable AI without vendor lock-in
- **Anyone** who's tired of being told the good version costs more

---

## The Philosophy

We think AI assistance should be a right, not a subscription tier.

The models are out there. Ollama, OpenRouter, and Hugging Face have done the hard work of making them accessible. OllamaUnofficial is just the bridge — a well-designed, no-nonsense VS Code extension that gets out of your way and lets you work.

It's free. It's open source. And we intend to keep it that way.

---

<div align="center">

**Come build with us.**

[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/gV7FzbrJCu)
[![GitHub](https://img.shields.io/badge/GitHub-Spiritbocs%2FOllamaUnofficial-24292e?style=for-the-badge&logo=github)](https://github.com/Spiritbocs/OllamaUnofficial)

<sub>OllamaUnofficial is an independent project and is not affiliated with Ollama, OpenRouter, or Hugging Face.</sub>

</div>
