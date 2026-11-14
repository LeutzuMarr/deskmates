/** The `load_skill` and `read_skill_file` tools a run's assistant (and bots) get when skills are set up on this machine. */
import { tool } from 'ai'
import { z } from 'zod'
import type { SkillsService } from './skills'

export function skillsTools(skills: SkillsService) {
  const summary = skills
    .list()
    .filter((s) => s.enabled)
    .map((s) => s.name)
    .sort()
    .join(', ')
  return {
    load_skill: tool({
      description: `Load a skill into your context so you can follow its workflow. Skills are reusable package-style instructions the user can install. Installed skills: ${summary || 'none'}. Call this when the task matches one of them, or when the user mentions a skill by name. The result gives the skill's folder: read its other files with read_skill_file, and run its scripts with run_command using that absolute folder path (e.g. python "<folder>/tools/render.py").`,
      inputSchema: z.object({
        name: z.string().min(1).describe('The name of the skill to load.')
      }),
      execute: async ({ name }) => {
        const loaded = skills.load(name)
        if (!loaded) {
          throw new Error(`No skill named "${name}" is installed and enabled. Installed skills: ${summary || 'none'}.`)
        }
        return {
          name: loaded.name,
          folder: loaded.folder || null,
          instructions: loaded.instructions,
          files: loaded.files
        }
      }
    }),
    read_skill_file: tool({
      description:
        "Read one text file that belongs to an installed skill (a reference, template, prompt or script listed in load_skill's files), even though it lives outside the project folder. Read-only.",
      inputSchema: z.object({
        name: z.string().min(1).describe('The skill name, as given to load_skill.'),
        path: z.string().min(1).describe('The file path relative to the skill folder, e.g. "references/sound.md".')
      }),
      execute: async ({ name, path }) => skills.readFile(name, path)
    })
  }
}
