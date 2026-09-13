import { SPEAKERS, validateDialogue } from './dialogue.js'
import SPEECH_CONFIG from './speechConfig.json' with { type: 'json' }

// Names and callback shapes verified against SDK 0.0.18 events.d.ts.
export const EVENTS = {
  ready: 'session.stream_ready', state: 'session.state_changed',
  disconnected: 'session.disconnected',
  started: 'avatar.speak_started', ended: 'avatar.speak_ended',
}
const cancelled = () => new DOMException('Operation cancelled', 'AbortError')

export function createDialogueController({
  dialogue: input, createSession, videos, onChange = () => {},
  preserveFrame = () => {}, clearFrame = () => {},
  fetchImpl = fetch, apiUrl = 'http://127.0.0.1:8000',
  log = (data) => console.log('[LiveAvatar]', data),
  clock = {
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
  },
  reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  limits = {},
  speechConfig = SPEECH_CONFIG,
}) {
  const time = { tts: 60000, tokens: 70000, connect: 45000,
    started: 15000, ended: 15000, fade: 150, media: 10000,
    completionHold: 300, completionFade: 600, ...limits }
  let dialogue, validationError
  try { dialogue = validateDialogue(input) } catch (error) { validationError = error.message }
  let disposed = false, current = null, serial = 0, busy = false, ready = false
  let hasPlayed = false, finishing = false, audioReady = false
  const sessions = new Map(), pcmCache = new Map()
  let view = { status: validationError ? 'Invalid dialogue' : 'Not prepared',
    error: validationError || null, speaker: null, caption: '', turn: 0 }

  function publish(update = {}) {
    view = { ...view, ...update }
    if (!disposed) onChange({ ...view, hasPlayed,
      canPrepare: !validationError && !busy && !audioReady,
      canPlay: !validationError && !busy && audioReady && !hasPlayed,
      canReplay: !validationError && (!busy || finishing) && audioReady && hasPlayed,
      canStop: busy || ready,
    })
  }
  function assertCurrent(op) {
    if (disposed || current !== op || op.signal.aborted) throw cancelled()
  }
  function wait(op, ms, setup, timeoutMessage) {
    assertCurrent(op)
    return new Promise((resolve, reject) => {
      let cleanup = () => {}, settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clock.clearTimeout(timer)
        op.signal.removeEventListener('abort', abort)
        cleanup()
        if (error) reject(error); else resolve(value)
      }
      const abort = () => finish(cancelled())
      const timer = clock.setTimeout(() => finish(new Error(timeoutMessage)), ms)
      op.signal.addEventListener('abort', abort, { once: true })
      try {
        cleanup = setup((value) => finish(null, value), (error) => finish(error)) || (() => {})
        if (settled) cleanup()
      } catch (error) { finish(error) }
    })
  }
  function delay(op, ms) {
    return wait(op, ms + 1000, (resolve) => {
      const timer = clock.setTimeout(resolve, ms)
      return () => clock.clearTimeout(timer)
    }, 'Transition timed out')
  }
  async function request(path, body, op, timeout) {
    const requestAbort = new AbortController()
    try {
      return await wait(op, timeout, (resolve, reject) => {
        fetchImpl(`${apiUrl}${path}`, {
          method: 'POST', signal: requestAbort.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).then(async (response) => {
          if (!response.ok) throw new Error(`${path} failed (${response.status})`)
          return response.json()
        }).then(resolve, () => reject(new Error(`${path} request failed`)))
        return () => requestAbort.abort()
      }, `${path} timed out`)
    } finally { requestAbort.abort() }
  }
  function pcmFor(index, op) {
    // This controller owns an immutable dialogue snapshot; a changed input
    // creates a new controller and therefore a new cache.
    if (!pcmCache.has(index)) {
      const pending = request('/tts', { text: dialogue[index].text, speaker: dialogue[index].speaker }, op, time.tts)
        .then((data) => {
          if (typeof data.audio !== 'string') throw new Error('Missing PCM audio')
          const pcm = atob(data.audio)
          if (!pcm.length || pcm.length % 2) throw new Error('Invalid 16-bit PCM byte count')
          return pcm
        }).catch((error) => {
          if (pcmCache.get(index) === pending) pcmCache.delete(index)
          throw error
        })
      pcmCache.set(index, pending)
    }
    return pcmCache.get(index)
  }
  function muteAndClear(clear = false) {
    for (const video of Object.values(videos)) {
      video.muted = true
      video.style.opacity = '0'
      if (clear) detachVideo(video)
    }
  }
  function detachVideo(video) {
    // There is no public SDK detach method in 0.0.18. Release the browser
    // tracks and reset the element explicitly so its last frame is discarded.
    const safely = (action) => {
      try { action() } catch { log({ event: 'media cleanup failed' }) }
    }
    safely(() => video.pause())
    safely(() => {
      for (const track of video.srcObject?.getTracks?.() ?? []) {
        safely(() => track.stop())
      }
    })
    safely(() => { video.srcObject = null })
    safely(() => video.removeAttribute('src'))
    safely(() => video.load())
    video.style.transitionDuration = ''
  }
  function stopSession(session) {
    try {
      if (session.state === 'CONNECTED') session.interrupt()
    } catch { /* Continue stopping if interrupt fails. */ }
    try {
      Promise.resolve(session.stop()).catch(() => log({ event: 'stop failed' }))
    } catch { log({ event: 'stop failed' }) }
  }
  function shutdown(preserve = false) {
    ready = false
    const records = [...sessions.values()]
    sessions.clear()
    // Invalidate records/listeners before stopping tracks: cleanup can emit
    // disconnect notifications synchronously.
    for (const record of records) {
      for (const [event, callback] of record.listeners) record.session.off(event, callback)
    }
    if (preserve) {
      try { preserveFrame(videos[view.speaker]) } catch { log({ event: 'frame capture failed' }) }
      for (const video of Object.values(videos)) {
        video.muted = true
        try { video.pause() } catch { log({ event: 'media cleanup failed' }) }
        for (const track of video.srcObject?.getTracks?.() ?? []) {
          try { track.stop() } catch { log({ event: 'media cleanup failed' }) }
        }
      }
    } else {
      clearFrame()
      muteAndClear(true)
    }
    for (const record of records) stopSession(record.session)
  }
  function cancel(status = 'Stopped', error = null) {
    const old = current
    current = null
    old?.abort()
    busy = false
    finishing = false
    shutdown()
    publish({ status, error, speaker: null, caption: '', turn: 0 })
  }
  async function connect(role, token, op) {
    const session = createSession(token, { voiceChat: false })
    const record = { session, listeners: [], seen: new Set(), pending: null }
    sessions.set(role, record)
    const listen = (event, callback) => {
      session.on(event, callback)
      record.listeners.push([event, callback])
    }
    listen(EVENTS.state, (state) => log({ role, event: EVENTS.state, state }))
    listen(EVENTS.disconnected, () => {
      if (sessions.get(role) === record) cancel('Disconnected', `${role} disconnected; prepare or replay to reconnect.`)
    })
    for (const eventType of [EVENTS.started, EVENTS.ended]) {
      listen(eventType, (event) => {
        const pending = record.pending
        // LITE emits event_type and event_id; optional source/session IDs
        // declared by the SDK are not emitted on this path.
        log({ role, turn: pending?.turn ?? null, operation: pending?.operation,
          event: event.event_type, event_id: event.event_id, time: performance.now() })
        const key = `${eventType}:${event.event_id}`
        if (record.seen.has(key)) return
        record.seen.add(key)
        if (!pending || current !== pending.op || pending.op.signal.aborted) return
        if (eventType === EVENTS.started) pending.started()
        else pending.ended()
      })
    }
    await wait(op, time.connect, (resolve, reject) => {
      let streamReady = false, started = false
      const check = () => { if (streamReady && started) resolve() }
      const onReady = () => { streamReady = true; check() }
      session.on(EVENTS.ready, onReady)
      // SDK start cannot be aborted. Stop a session that connects after Stop,
      // timeout, unmount, or a failure in the other session.
      Promise.resolve().then(() => { assertCurrent(op); return session.start() }).then(() => {
        if (current !== op || op.signal.aborted || disposed) { stopSession(session); return }
        started = true
        check()
      }, () => reject(new Error(`${role} connection failed`)))
      return () => session.off(EVENTS.ready, onReady)
    }, `${role} connection/media readiness timed out`)
    assertCurrent(op)
    session.attach(videos[role])
    videos[role].muted = true
  }
  async function ensurePrepared(op) {
    publish({ status: 'Preparing your feedback...', error: null })
    // Serial requests preserve successful entries if preparation is stopped.
    for (let index = 0; index < 4; index++) {
      await pcmFor(index, op)
      assertCurrent(op)
    }
    audioReady = true
  }
  async function connectSessions(op) {
    // Play and Replay always establish a fresh pair; neither path requests TTS.
    if (sessions.size) shutdown()
    publish({ status: 'Connecting both avatars...' })
    const data = await request('/liveavatar/dialogue-tokens', {}, op, time.tokens)
    assertCurrent(op)
    if (SPEAKERS.some((role) => typeof data.tokens?.[role] !== 'string' || !data.tokens[role])) {
      throw new Error('Missing role session token')
    }
    await Promise.all(SPEAKERS.map((role) => connect(role, data.tokens[role], op)))
    assertCurrent(op)
    ready = true
  }
  async function showTurn(turn, index, op) {
    const fade = reducedMotion() ? 0 : time.fade
    muteAndClear()
    await delay(op, fade)
    assertCurrent(op)
    publish({ speaker: turn.speaker, caption: turn.text, turn: index + 1,
      status: 'Awaiting speech...' })
    const video = videos[turn.speaker]
    video.style.opacity = '1'
    video.muted = false
    await wait(op, time.media, (resolve, reject) => {
      Promise.resolve(video.play()).then(resolve,
        () => reject(new Error('Browser blocked playback. Click Replay Feedback to retry.')))
    }, 'Media playback timed out')
    await delay(op, fade)
    // The existing fades count toward the conversational pause. Reduced motion
    // removes animation, not the pause. No extra pause on turn 1 or after turn 4.
    if (index > 0) {
      const remainingGap = Math.max(0, speechConfig.turnDelayMs[turn.speaker] - 2 * fade)
      await delay(op, remainingGap)
    }
  }
  function speak(index, pcm, op) {
    const role = dialogue[index].speaker
    const record = sessions.get(role)
    return wait(op, time.started + time.ended + pcm.length / 48, (resolve, reject) => {
      let started = false
      let timer = clock.setTimeout(() => reject(new Error(`${role} speech start timed out`)), time.started)
      record.pending = {
        op, operation: op.id, turn: index + 1,
        started() {
          if (started) return
          started = true
          clock.clearTimeout(timer)
          timer = clock.setTimeout(() => reject(new Error(`${role} speech completion timed out`)),
            time.ended + pcm.length / 48)
          publish({ status: 'Speaking...' })
        },
        ended() { if (started) resolve() },
      }
      try {
        const localCommandId = record.session.repeatAudio(pcm)
        log({ role, turn: index + 1, operation: op.id, bytes: pcm.length,
          localCommandId, note: 'Local command ID differs from WebSocket event ID' })
      } catch { reject(new Error(`${role} audio send failed`)) }
      return () => { clock.clearTimeout(timer); record.pending = null }
    }, `${role} speech timed out`)
  }
  async function complete(op) {
    assertCurrent(op)
    finishing = true
    publish({ status: 'Finishing feedback...' })
    for (const video of Object.values(videos)) video.muted = true
    await delay(op, time.completionHold)
    assertCurrent(op)
    const fade = reducedMotion() ? 0 : time.completionFade
    // Preserve completion timing while keeping the final avatar visible.
    await delay(op, fade)
    assertCurrent(op)
    shutdown(true)
    current = null
    op.abort()
    busy = false
    finishing = false
    publish({ status: 'Feedback Complete' })
  }
  async function run(playback) {
    if (busy || disposed || validationError || (playback && !audioReady)) return
    clearFrame()
    if (hasPlayed) muteAndClear(true)
    busy = true // Synchronous: guards clicks before React can rerender.
    const op = new AbortController()
    op.id = ++serial
    current = op
    publish({ status: playback ? 'Connecting both avatars...' : 'Preparing your feedback...', error: null, speaker: null, caption: '', turn: 0 })
    try {
      if (playback) {
        hasPlayed = true
        await connectSessions(op)
        for (let index = 0; index < dialogue.length; index++) {
          assertCurrent(op)
          await showTurn(dialogue[index], index, op)
          assertCurrent(op)
          await speak(index, await pcmCache.get(index), op)
        }
        await complete(op)
      } else {
        await ensurePrepared(op)
        busy = false
        publish({ status: 'Ready to play' })
      }
    } catch (error) {
      if (current === op && !disposed) {
        console.error('[LiveAvatar] dialogue operation failed', {
          operation: op.id,
          name: error.name,
          message: error.message,
        })
        cancel('Failed', error.message)
      }
    }
  }
  muteAndClear()
  publish()
  return {
    prepare: () => run(false),
    play: () => run(true),
    replay: () => {
      if (finishing) cancel()
      return run(true)
    },
    stop: () => cancel(),
    dispose() { disposed = true; cancel(); pcmCache.clear() },
  }
}
