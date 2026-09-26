/** The `load_skill` tool a run's assistant (and bots) get when skills are set up on this machine. */
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
      description: `Load a skill into your context so you can follow its workflow. Skills are reusable package-style instructions the user can install. Installed skills: ${summary || 'none'}. Call this when the task matches one of them, or when the user mentions a skill by name.`,
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
          instructions: loaded.instructions,
          files: loaded.files
        }
      }
    })
  }
}