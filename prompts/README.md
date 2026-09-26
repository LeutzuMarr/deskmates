# Base prompts (optional)

Deskmates' agents work out of the box with their built-in instructions. You can instead give them a full system prompt of your own, one Markdown file per tab:

| File | Used by |
|---|---|
| `prompts/claude-cowork/claude-cowork.md` | the Work tab |
| `prompts/claude-design/claude-design.md` | the Design tab |
| `prompts/claude-code/claude-code-opus-5.5.md` | the guide given to connected terminal agents (OpenCode, Antigravity…) |

When a file is present, it becomes that tab's system prompt and the built-in rules step aside. Deskmates then adds only a short description of the environment: the project folder, the date, the model, your saved memories, installed skills and your own instructions. Deskmates already has most of the tools these prompts expect: files, shell, web, sub-agents, design components, rendering and video export.

Set `DESKMATES_PROMPTS_DIR` to keep the files somewhere else. The files in this folder are ignored by git, so your own prompts are never published.
