export const SPEAKERS = ['Professor', 'Student']

export function validateDialogue(dialogue) {
  const order = ['Professor', 'Student', 'Professor', 'Student']
  if (!Array.isArray(dialogue) || dialogue.length !== 4) {
    throw new Error('Feedback must contain exactly four turns.')
  }
  return Object.freeze(order.map((speaker, index) => {
    const turn = dialogue[index]
    if (!turn || turn.speaker !== speaker) {
      throw new Error(`Turn ${index + 1} must be spoken by ${speaker}.`)
    }
    if (typeof turn.text !== 'string' || !turn.text.trim()) {
      throw new Error(`Turn ${index + 1} must contain nonempty text.`)
    }
    return Object.freeze({ speaker: turn.speaker, text: turn.text })
  }))
}
