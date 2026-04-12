#!/bin/bash
cd /vercel/share/v0-project
git add media/chat.css package.json
git commit -m "fix: recreate theme with Claude Code styling and Ollama colors

- Rewrote CSS with hardcoded dark theme values (no VS Code variable dependency)
- Added --oui-* custom properties for consistent theming
- Fixed all form elements (inputs, selects, checkboxes, buttons)
- Applied Claude Code-inspired design with Ollama cyan accent (#0ea5e9)
- Bumped version to 0.3.4"
git push origin theme-recreation-for-vs-code
