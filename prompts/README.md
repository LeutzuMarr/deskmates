# Base prompts (optional)

Deskmates' agents work out of the box with their built-in instructions. You can instead give them a full system prompt of your own, one Markdown file per tab:

| File | Used by |
|---|---|
| `prompts/fable/claude-fable-5.2.md` | the Work tab, bots, computer use, Duo and connected terminal agents (Freebuff, OpenCode, Antigravity…) |
| `prompts/my-prompt/my-prompt.md` | the same agents, only when the Fable file isn't there |
| `prompts/claude-design/claude-design.md` | the Design tab |
| `prompts/claude-cowork/claude-cowork.md` | kept, but not read by any agent |
| `prompts/claude-code/claude-code-opus-5.5.md` | kept, but not read by any agent |

Each agent gets one prompt. The operating prompt is large, so agents get its first section in full plus an index of the other sections and their parts, which they read only when a task needs one. Its "Tools" sections become real tools under the same names and schemas.

Three guides are read only when a task calls for them, never otherwise:

| File | When |
|---|---|
| `prompts/claude-in-chrome/claude-in-chrome.md` | before an agent's first step in your own Chrome (`read_chrome_instructions`, the `chrome-browser` skill, or with the first Chrome result of a task) |
| `prompts/research/research_instructions.md` | when you ask for research (`read_research_instructions`) |
| `prompts/visualize/visualize.md` | before an inline visual (`mcp__visualize__read_me`, one module at a time) |

The effort table at the top of the Fable file sets what the effort button next to the model sends: the level you pick becomes the prompt's `<reasoning_effort>` value for every agent, and models with their own reasoning setting get it too.

When a file is present, it becomes that tab's system prompt and the built-in rules step aside. Deskmates then adds only a short description of the environment: the project folder, the date, the model, your saved memories, installed skills and your own instructions.

Set `DESKMATES_PROMPTS_DIR` to keep the files somewhere else. The files in this folder are ignored by git, so your own prompts are never published.
