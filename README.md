# OllamaUnofficial

A free, open-source AI coding assistant sidebar for Visual Studio Code. Run models locally with Ollama, or connect to OpenRouter and Hugging Face — no subscriptions, no telemetry, no lock-in.

---

## Capabilities

| Feature | Description |
|---|---|
| **File System Access** | Read and write files directly in your workspace |
| **Multi-file Context** | Understands your entire project structure |
| **Inline Editing** | Apply AI-suggested code to files with one click |
| **Code Generation** | Generate, refactor, and fix code in any language |
| **Terminal Access** | Run proposed commands in the integrated terminal |
| **Git Integration** | View status, diffs, commit, and push — all from chat |
| **Chat Context** | Remembers your conversation across sessions and files |
| **File Navigation** | Jump to any file in your workspace instantly |

---

## What Can It Do?

- **Ask about any file** — attach it with the + Context button or ask by name
- **Request changes** — "Add error handling to src/api.ts" → click Apply
- **See changes before applying** — confirm before anything is written to disk
- **Run code** — shell code blocks get a ▶ Run button for the integrated terminal
- **Git workflow** — ask for a git status, review a diff, or commit staged changes
- **Refactor** — improve code quality, rename things, restructure modules
- **Debug** — attach your Problems panel and ask the AI to fix the errors

---

## Providers

| Provider | Details |
|---|---|
| **Ollama (local)** | Fully private, no internet needed, no API key. Runs on your own GPU/CPU. |
| **OpenRouter** | Hundreds of cloud models, many completely free ($0/token). |
| **Hugging Face** | HF Inference Providers via your own HF token. |

Switch providers any time from the dropdown in the header.

---

## Chat Modes

- **Agent** — step-by-step coding tasks, asks questions when blocked
- **Ask** — direct answers, minimal preamble
- **Plan** — numbered plan first, then details and code

---

## Requirements

### Ollama (local models)

Install [Ollama](https://ollama.com) and pull a model:

```bash
ollama pull llama3.2
```

The extension connects to `http://127.0.0.1:11434` by default. On first launch it will:
- Check if Ollama is running
- Notify you if it's installed but not started (and offer to start it)
- Offer to download it if it's not installed yet
- Check GitHub for updates and notify you if a newer version is available

### OpenRouter

1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys)
3. Enter it in the ⚙ settings panel

### Hugging Face

1. Create an account at [huggingface.co](https://huggingface.co)
2. Generate a token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) with **Inference Providers** permission
3. Enter it in the ⚙ settings panel

---

## Installation

### From the .vsix file

1. Download `ollamaunofficial-0.1.0.vsix` from the `release/` folder
2. Open VS Code
3. Press `Ctrl+Shift+P` → **Install from VSIX**
4. Select the file → **Reload Now**

The OllamaUnofficial icon will appear in your Activity Bar.

### From source

See [CONTRIB.md](./CONTRIB.md) for full build instructions.

---

## Getting Started

1. Click the OllamaUnofficial icon in the Activity Bar.
2. Choose your provider from the header dropdown.
3. Click **⚙** to open settings and configure keys and permissions.
4. Type a message and press **Enter**.

To unlock file editing, terminal execution, and git operations, open **⚙ Settings** and enable them in the **Workspace & Terminal Access** section.

---

## Permissions (⚙ Settings Panel)

These are all off by default and opt-in:

| Permission | What it unlocks |
|---|---|
| **File Access: Read** | AI can see workspace file structure; you can attach files by name |
| **File Access: Read & Write** | AI code blocks get an **Apply to File** button; one click writes the file |
| **Terminal Access** | Shell code blocks get a **▶ Run** button that sends the command to the integrated terminal |
| **Git Access** | Ask for git status, open diffs, commit staged changes, push to remote |

---

## Code Block Actions

When the AI responds with code, action buttons appear on hover:

- **Copy** — copies the raw code to clipboard
- **Apply to File** — writes the code to a file you choose (requires Read & Write access). If the first line of the code block is a comment like `// File: src/utils.ts`, the path is pre-filled.
- **▶ Run** — sends shell/bash/zsh commands straight to the integrated terminal (requires Terminal Access)

---

## Context Attachments

Click **+ Context** to attach context before sending a message:

- Active file in the editor
- Any open editor tab
- Any file from disk (file picker)
- Current lint/compiler problems
- Image from clipboard

---

## Multiple Sessions

Use **+** in the header to open new chat tabs. Each tab has its own history. Click **✎** on a tab to rename it.

---

## VS Code Settings

| Setting | Default | Description |
|---|---|---|
| `ollamaCoderChat.baseUrl` | `http://127.0.0.1:11434` | Ollama server URL |
| `ollamaCoderChat.provider` | `ollama` | Active provider |
| `ollamaCoderChat.model` | `llama3.2` | Default model ID |
| `ollamaCoderChat.openRouterFreeOnly` | `true` | Only list free ($0) models from OpenRouter |
| `ollamaCoderChat.temperature` | `0.2` | Sampling temperature (0–2) |
| `ollamaCoderChat.maxTokens` | `4096` | Max tokens to generate |
| `ollamaCoderChat.topP` | `1` | Nucleus sampling top-p |
| `ollamaCoderChat.fileAccess` | `none` | `none` / `read` / `readwrite` |
| `ollamaCoderChat.terminalAccess` | `false` | Allow terminal command execution |
| `ollamaCoderChat.gitAccess` | `false` | Allow git operations |
| `ollamaCoderChat.approvalMode` | `ask` | How code edits are handled |
| `ollamaCoderChat.models` | `[]` | Extra model IDs to always show |

---

## Commands

| Command | What it does |
|---|---|
| `OllamaUnofficial: Focus Chat` | Open and focus the chat sidebar |
| `OllamaUnofficial: New Chat Tab` | Start a new session |
| `OllamaUnofficial: Set OpenRouter API Key` | Securely store your OpenRouter key |
| `OllamaUnofficial: Set Hugging Face API Token` | Securely store your HF token |
| `OllamaUnofficial: Show Log` | Open the output panel for debugging |

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Enter` | Send message |
| `Shift+Enter` | New line in the message box |

---

## Privacy

- Ollama: **nothing leaves your machine**
- OpenRouter / Hugging Face: messages are sent to those services under their own privacy policies
- API keys are stored in VS Code's encrypted Secret Storage — never in `settings.json`

---

## Changelog

### 0.1.0
- File System Access: read and write workspace files, Apply-to-File button on all code blocks
- Terminal Access: ▶ Run button on shell code blocks, integrated terminal execution
- Git Integration: status, diff view, commit, and push from chat
- File Navigation: open any workspace file mentioned in chat
- Workspace tree: the AI can see your full project structure
- Ollama health check: detects if Ollama is missing or outdated and guides you through setup
- Capabilities grid in the empty state showing what's enabled
- Settings panel: new Workspace & Terminal Access section
- Improved code block action toolbar (Copy / Apply / Run)

### 0.0.1
- Initial release: Ollama, OpenRouter, Hugging Face providers
- Multi-session tabs, context attachments, Agent/Ask/Plan modes
- Secure API key storage, improved settings panel

---

## License

MIT — see `LICENSE` for details.
