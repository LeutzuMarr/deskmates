/** The display tools, under the older prompt's names; the Fable prompt names them mcp__widgets__…. */
const DISPLAY_NAMES = [
  'chart_display_v0',
  'comparison_card_display_v0',
  'featured_card_display_v0',
  'itinerary_display_v0',
  'link_preview_display_v0',
  'message_compose_v1',
  'options_card_display_v0',
  'places_list_display_v0',
  'places_map_display_v0',
  'product_carousel_display_v0',
  'quiz_display_v0',
  'recipe_display_v0',
  'show_recommendation_cards',
  'step_card_display_v0',
  'translation_display_v0'
]

/** Tools whose result the chat draws as an inline widget frame (see core/tools/widgets.ts). */
export const WIDGET_TOOL_NAMES: readonly string[] = [
  ...DISPLAY_NAMES,
  ...DISPLAY_NAMES.map((name) => `mcp__widgets__${name}`),
  'image_search',
  'mcp__claude_ai__image_search',
  'mcp__visualize__show_widget',
  'Artifact',
  'propose_skills'
]

/** A widget frame asks the chat to send this text as the user's next message (the Visualizer's sendPrompt). */
export const WIDGET_PROMPT_MESSAGE = 'deskmates-widget-prompt'
