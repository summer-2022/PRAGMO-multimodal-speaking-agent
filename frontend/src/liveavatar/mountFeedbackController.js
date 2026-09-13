import { createDialogueController } from './dialogueController.js'

// Defer automatic work until after StrictMode's setup/cleanup/setup probe.
// Each mount owns one controller and cache, even for identical dialogue text.
export function mountFeedbackController(options, {
  schedule = queueMicrotask, createController = createDialogueController,
} = {}) {
  let disposed = false, controller = null
  schedule(() => {
    if (disposed) return
    controller = createController(options)
    void controller.prepare()
  })
  return {
    play: () => controller?.play(),
    replay: () => controller?.replay(),
    retryPreparation: () => controller?.prepare(),
    stop: () => controller?.stop(),
    dispose() { disposed = true; controller?.dispose(); controller = null },
  }
}
