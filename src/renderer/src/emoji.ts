/** The reactions offered in one click under the pointer, and the full choice in the picker. */
export const QUICK_REACTIONS = ['👍', '😂', '❤️']

export const EMOJI_GROUPS: { label: 'emojiFaces' | 'emojiGestures' | 'emojiThings'; emoji: string[] }[] = [
  {
    label: 'emojiFaces',
    emoji: ['😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '🤔', '😏', '🙃', '😴', '😮', '😬', '😭', '😢', '😡', '🤯', '🥳', '🤡', '💀', '👀', '🫠', '🥲']
  },
  {
    label: 'emojiGestures',
    emoji: ['👍', '👎', '👏', '🙏', '💪', '🤝', '✌️', '👌', '🤌', '🫡', '🤙', '👋', '🫶', '🤞', '☝️', '🙌']
  },
  {
    label: 'emojiThings',
    emoji: ['❤️', '💔', '🔥', '✨', '🎉', '💯', '✅', '❌', '⚠️', '🎮', '🕹️', '🏆', '🍕', '🍻', '☕', '🌙', '⭐', '🐐', '💤', '🎧', '📌', '🚀', '💸', '🤷']
  }
]
