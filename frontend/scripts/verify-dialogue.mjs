import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { SessionState, SessionEvent, AgentEventsEnum } from '@heygen/liveavatar-web-sdk'
import { validateDialogue } from '../src/liveavatar/dialogue.js'
const TEST_DIALOGUE = ['Professor', 'Student', 'Professor', 'Student'].map((speaker, i) => ({ speaker, text: `  Dynamic turn ${i + 1}—exact punctuation?\nThank you!  ` }))
import SPEECH_CONFIG from '../src/liveavatar/speechConfig.json' with { type: 'json' }
import { createDialogueController, EVENTS } from '../src/liveavatar/dialogueController.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick() }
  assert.fail('Expected condition was not reached')
}
function harness(options = {}) {
  const calls = [], sessions = [], views = [], timers = new Map()
  let timerId = 0
  const clock = {
    setTimeout(fn, ms) {
      const id = ++timerId
      if (ms === 0) queueMicrotask(fn)
      else timers.set(id, { fn, ms })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
  }
  class Session extends EventEmitter {
    state = 'INACTIVE'; sent = []; stops = 0; interrupts = 0
    start() {
      if (options.manualStart) return new Promise((resolve) => { this.finishStart = () => { this.state = 'CONNECTED'; resolve() } })
      this.state = 'CONNECTED'
      this.emit(EVENTS.ready)
      return Promise.resolve()
    }
    tracks = [{ stops: 0, stop() { this.stops++ } }, { stops: 0, stop() { this.stops++ } }]
    attach(video) { video.srcObject = { getTracks: () => this.tracks } }
    stop() { this.stops++; this.state = 'DISCONNECTED'; return Promise.resolve() }
    interrupt() { this.interrupts++ }
    repeatAudio(pcm) { this.sent.push(pcm); calls.push(['speak', sessions.indexOf(this)]); return 'local-id' }
  }
  const videos = Object.fromEntries(['Professor', 'Student'].map((role) => [role, {
    muted: true, style: {}, srcObject: null, pauses: 0, loads: 0, removed: [],
    pause() { this.pauses++ }, load() { this.loads++ },
    removeAttribute(name) { this.removed.push(name) }, play: () => Promise.resolve(),
  }]))
  const controller = createDialogueController({
    dialogue: options.dialogue ?? TEST_DIALOGUE, videos, clock,
    preserveFrame: (video) => {
      assert.ok(sessions.slice(-2).every((session) => session.stops === 0))
      calls.push(['frame', video])
    },
    clearFrame: () => calls.push(['clear-frame']),
    limits: options.realCompletion ? {} : { completionHold: 0, completionFade: 150 },
    speechConfig: options.speechTiming ? SPEECH_CONFIG : {
      ...SPEECH_CONFIG, turnDelayMs: { Professor: 0, Student: 0 },
    },
    reducedMotion: () => options.reducedMotion ?? true, log() {}, onChange: (view) => views.push(view),
    createSession: () => { const session = new Session(); sessions.push(session); return session },
    fetchImpl: async (url, init) => {
      calls.push([url.split('/').at(-1), JSON.parse(init.body)])
      if (options.fetchImpl) return options.fetchImpl(url, init)
      return { ok: true, json: async () => url.endsWith('/tts')
        ? { audio: btoa('\x00\x01'.repeat(24000)) }
        : { tokens: { Professor: 'offline-professor', Student: 'offline-student' } } }
    },
  })
  let eventId = 0
  const emit = (session, type, id = String(++eventId)) => session.emit(type, { event_type: type, event_id: id })
  return { controller, sessions, calls, videos, views, timers, emit,
    get view() { return views.at(-1) },
    expire(ms) { const timer = [...timers.values()].find((t) => t.ms === ms); assert.ok(timer); timer.fn() },
  }
}
async function finishFour(h, offset = 0) {
  for (let i = 0; i < 4; i++) {
    await until(() => h.calls.filter(([kind]) => kind === 'speak').length === offset + i + 1)
    assert.equal(h.view.turn, i + 1)
    assert.equal(h.view.caption, TEST_DIALOGUE[i].text)
    const session = h.sessions.at(-2 + i % 2)
    h.emit(session, EVENTS.started)
    h.emit(session, EVENTS.ended)
  }
}

test('exact fixture and strict validation without text rewriting', () => {
  for (const value of [null, [], TEST_DIALOGUE.slice(1), [...TEST_DIALOGUE, TEST_DIALOGUE[0]],
    TEST_DIALOGUE.map((t) => ({ ...t, speaker: 'Student' })),
    TEST_DIALOGUE.map((t) => ({ ...t, text: ' ' }))]) assert.throws(() => validateDialogue(value))
  const spaced = TEST_DIALOGUE.map((t) => ({ ...t, text: ` ${t.text} ` }))
  assert.equal(validateDialogue(spaced)[0].text, spaced[0].text)
})

test('invalid input performs no requests', async () => {
  const h = harness({ dialogue: [] }); await h.controller.play()
  assert.equal(h.calls.length, 0); assert.equal(h.view.status, 'Invalid dialogue')
  h.controller.dispose()
})

test('four ordered turns, captions, inactive/duplicate gating, cached replay and click lock', async () => {
  const h = harness()
  await Promise.all([h.controller.prepare(), h.controller.prepare()])
  assert.equal(h.sessions.length, 0)
  assert.equal(h.calls.filter(([kind]) => kind === 'dialogue-tokens').length, 0)
  assert.equal(h.calls.filter(([kind]) => kind === 'tts').length, 4)
  await h.controller.prepare(); const run = h.controller.play()
  await h.controller.play()
  await until(() => h.sessions[0]?.sent.length === 1)
  h.emit(h.sessions[1], EVENTS.started)
  h.emit(h.sessions[1], EVENTS.ended)
  h.emit(h.sessions[0], EVENTS.ended, 'premature')
  await tick(); assert.equal(h.sessions[1].sent.length, 0)
  await finishFour(h)
  await run
  assert.equal(h.view.status, 'Feedback Complete')
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'speak').map((c) => c[1]), [0, 1, 0, 1])
  const replay = h.controller.replay()
  await until(() => h.sessions[2]?.sent.length === 1)
  h.emit(h.sessions[0], EVENTS.ended, 'premature')
  await finishFour(h, 4); await replay
  assert.equal(h.calls.filter(([kind]) => kind === 'tts').length, 4)
  assert.equal(h.sessions.length, 4)
  h.controller.dispose(); assert.equal(h.timers.size, 0)
})

test('readiness requires both start completion and media tracks', async () => {
  const h = harness({ manualStart: true }); await h.controller.prepare(); const run = h.controller.play()
  await until(() => h.sessions.length === 2 && h.sessions.every((s) => s.finishStart))
  h.sessions[0].emit(EVENTS.ready); h.sessions[1].finishStart()
  await tick(); assert.equal(h.view.canPlay, false)
  h.sessions[0].finishStart(); h.sessions[1].emit(EVENTS.ready)
  await until(() => h.sessions[0]?.sent.length === 1); h.controller.stop(); await run; h.controller.dispose()
})

test('Stop prevents advancement and late events; replay reconnects with cached PCM', async () => {
  const h = harness(); await h.controller.prepare(); const run = h.controller.play()
  await until(() => h.sessions[0]?.sent.length === 1)
  const old = [...h.sessions]; h.controller.stop()
  h.emit(old[0], EVENTS.started); h.emit(old[0], EVENTS.ended)
  await run
  assert.equal(h.calls.filter(([kind]) => kind === 'speak').length, 1)
  assert.ok(old.every((s) => s.stops === 1 && s.interrupts === 1))
  assert.ok(Object.values(h.videos).every((v) => v.muted && v.srcObject === null))
  const replay = h.controller.replay()
  await until(() => h.sessions.length === 4 && h.sessions[2].sent.length === 1)
  assert.equal(h.view.turn, 1)
  assert.equal(h.calls.filter(([kind]) => kind === 'tts').length, 4)
  h.controller.stop(); await replay; h.controller.dispose()
})

test('connection cancelled or timed out is stopped again on late connection', async () => {
  for (const timeout of [false, true]) {
    const h = harness({ manualStart: true }); await h.controller.prepare(); const run = h.controller.play()
    await until(() => h.sessions.length === 2 && h.sessions.every((s) => s.finishStart))
    if (timeout) h.expire(45000); else h.controller.stop()
    await run
    for (const session of h.sessions) session.finishStart()
    await tick()
    assert.ok(h.sessions.every((s) => s.stops >= 2))
    assert.equal(h.view.canPlay, false); h.controller.dispose()
  }
})

test('start timeout, completion timeout and disconnect stop both sessions', async () => {
  for (const failure of ['start', 'end', 'disconnect']) {
    const h = harness(); await h.controller.prepare(); const run = h.controller.play()
    await until(() => h.sessions[0]?.sent.length === 1)
    if (failure === 'start') h.expire(15000)
    if (failure === 'end') { h.emit(h.sessions[0], EVENTS.started); h.expire(16000) }
    if (failure === 'disconnect') h.sessions[1].emit(EVENTS.disconnected)
    await run
    assert.ok(h.sessions.every((s) => s.stops === 1))
    assert.equal(h.calls.filter(([kind]) => kind === 'speak').length, 1)
    h.controller.dispose(); assert.equal(h.timers.size, 0)
  }
})

test('unmount cancels fetch, publishes no stale state and new dialogue gets a fresh cache', async () => {
  let signal
  const h = harness({ fetchImpl: async (_, init) => { signal = init.signal; return new Promise(() => {}) } })
  const run = h.controller.prepare(); await until(() => signal)
  const count = h.views.length; h.controller.dispose(); await run
  assert.ok(signal.aborted); assert.equal(h.views.length, count); assert.equal(h.timers.size, 0)
  const next = harness({ dialogue: TEST_DIALOGUE.map((t) => ({ ...t, text: t.text + ' ' })) })
  await next.controller.prepare(); assert.equal(next.calls.filter(([kind]) => kind === 'tts').length, 4)
  next.controller.dispose()
})

test('autoplay rejection aborts before sending any speech', async () => {
  const h = harness(); h.videos.Professor.play = () => Promise.reject(new Error('blocked'))
  await h.controller.prepare(); await h.controller.play()
  assert.equal(h.calls.filter(([kind]) => kind === 'speak').length, 0)
  assert.match(h.view.error, /Browser blocked/); h.controller.dispose()
})

test('fade hides both speakers before showing only the next speaker', async () => {
  const h = harness({ reducedMotion: false }); await h.controller.prepare(); const run = h.controller.play()
  await until(() => h.view.status === 'Ready' || [...h.timers.values()].some((t) => t.ms === 150))
  assert.ok(Object.values(h.videos).every((v) => v.style.opacity === '0' && v.muted))
  h.expire(150)
  await until(() => h.view.turn === 1 && [...h.timers.values()].some((t) => t.ms === 150))
  assert.equal(h.videos.Professor.style.opacity, '1'); assert.equal(h.videos.Student.style.opacity, '0')
  assert.equal(h.sessions[0].sent.length, 0)
  h.expire(150); await until(() => h.sessions[0]?.sent.length === 1)
  h.emit(h.sessions[0], EVENTS.started); h.emit(h.sessions[0], EVENTS.ended)
  await until(() => h.videos.Professor.style.opacity === '0')
  assert.ok(Object.values(h.videos).every((v) => v.style.opacity === '0' && v.muted))
  h.controller.stop(); await run; h.controller.dispose()
})

test('TTS timeout aborts its request and creates no sessions', async () => {
  let signal
  const h = harness({ fetchImpl: (_, init) => { signal = init.signal; return new Promise(() => {}) } })
  const run = h.controller.prepare(); h.expire(60000); await run
  assert.ok(signal.aborted); assert.equal(h.sessions.length, 0)
  assert.match(h.view.error, /timed out/); h.controller.dispose()
})

test('partial TTS failure retains successful PCM on preparation retry', async () => {
  let ttsCalls = 0, fail = true
  const h = harness({ fetchImpl: async (url) => {
    if (url.endsWith('/tts')) {
      ttsCalls++
      if (ttsCalls === 2 && fail) throw new Error('offline failure')
      return { ok: true, json: async () => ({ audio: btoa('\x00\x01') }) }
    }
    return { ok: true, json: async () => ({ tokens: { Professor: 'p', Student: 's' } }) }
  } })
  await h.controller.prepare(); assert.equal(h.sessions.length, 0)
  fail = false; await h.controller.prepare()
  assert.equal(ttsCalls, 5); assert.equal(h.view.canPlay, true); h.controller.dispose()
})

test('token timeout and incomplete pair never start a partial session', async () => {
  for (const timeout of [true, false]) {
    const h = harness({ fetchImpl: async (url) => {
      if (url.endsWith('/tts')) return { ok: true, json: async () => ({ audio: btoa('\x00\x01') }) }
      if (timeout) return new Promise(() => {})
      return { ok: true, json: async () => ({ tokens: { Professor: 'p' } }) }
    } })
    await h.controller.prepare()
    const run = h.controller.play()
    if (timeout) { await until(() => [...h.timers.values()].some((t) => t.ms === 70000)); h.expire(70000) }
    await run; assert.equal(h.sessions.length, 0); assert.equal(h.view.status, 'Failed')
    h.controller.dispose()
  }
})

test('duplicate ended event after next started cannot skip that role’s later turn', async () => {
  const h = harness(); await h.controller.prepare(); const run = h.controller.play()
  await until(() => h.sessions[0]?.sent.length === 1)
  h.emit(h.sessions[0], EVENTS.started, 'p-start-1'); h.emit(h.sessions[0], EVENTS.ended, 'p-end-1')
  await until(() => h.sessions[1].sent.length === 1)
  h.emit(h.sessions[1], EVENTS.started); h.emit(h.sessions[1], EVENTS.ended)
  await until(() => h.sessions[0].sent.length === 2)
  h.emit(h.sessions[0], EVENTS.started, 'p-start-3'); h.emit(h.sessions[0], EVENTS.ended, 'p-end-1')
  await tick(); assert.equal(h.sessions[1].sent.length, 1)
  h.controller.stop(); await run; h.controller.dispose()
})


test('controller event names and connection state match the installed SDK', () => {
  assert.equal(SessionState.CONNECTED, 'CONNECTED')
  assert.equal(EVENTS.ready, SessionEvent.SESSION_STREAM_READY)
  assert.equal(EVENTS.state, SessionEvent.SESSION_STATE_CHANGED)
  assert.equal(EVENTS.disconnected, SessionEvent.SESSION_DISCONNECTED)
  assert.equal(EVENTS.started, AgentEventsEnum.AVATAR_SPEAK_STARTED)
  assert.equal(EVENTS.ended, AgentEventsEnum.AVATAR_SPEAK_ENDED)
})

test('default timers preserve the host receiver and failures log only diagnostic fields', async (t) => {
  const timers = new Set(), errors = [], requests = [], views = []
  let timerId = 0, cleared = 0
  t.mock.method(globalThis, 'setTimeout', function () {
    assert.equal(this, globalThis, 'setTimeout must retain the host receiver')
    timers.add(++timerId)
    return timerId
  })
  t.mock.method(globalThis, 'clearTimeout', function (id) {
    assert.equal(this, globalThis, 'clearTimeout must retain the host receiver')
    assert.ok(timers.delete(id))
    cleared++
  })
  t.mock.method(console, 'error', (...args) => errors.push(args))
  const controller = createDialogueController({
    // Intentionally omit clock to exercise the production default.
    dialogue: TEST_DIALOGUE,
    videos: Object.fromEntries(['Professor', 'Student'].map((role) => [role, {
      style: {}, pause() {}, load() {}, removeAttribute() {}, muted: true, srcObject: null,
    }])),
    onChange: (view) => views.push(view),
    createSession: () => assert.fail('Invalid PCM must not start a session'),
    fetchImpl: async (url) => {
      requests.push(url)
      // Deliberate post-fetch failure also verifies the Console diagnostic.
      return { ok: true, json: async () => ({ audio: '' }) }
    },
  })
  try {
    await controller.prepare()
    assert.deepEqual(requests, ['http://127.0.0.1:8000/tts'])
    assert.equal(cleared, 1)
    assert.equal(timers.size, 0)
    assert.equal(views.at(-1).status, 'Failed')
    assert.deepEqual(errors, [[
      '[LiveAvatar] dialogue operation failed',
      { operation: 1, name: 'Error', message: 'Invalid 16-bit PCM byte count' },
    ]])
  } finally {
    controller.dispose()
  }
})

test('configured speech gaps include fades, survive reduced motion, and preserve cached role requests', async () => {
  for (const reducedMotion of [false, true]) {
    const h = harness({ speechTiming: true, reducedMotion })
    async function playConfigured(replay) {
      const before = h.calls.filter(([kind]) => kind === 'speak').length
      if (!replay) await h.controller.prepare()
      const run = replay ? h.controller.replay() : h.controller.play()
      for (let index = 0; index < 4; index++) {
        if (!reducedMotion) {
          for (let fade = 0; fade < 2; fade++) {
            await until(() => [...h.timers.values()].some((timer) => timer.ms === 150))
            h.expire(150)
          }
        }
        if (index > 0) {
          const remainder = SPEECH_CONFIG.turnDelayMs[TEST_DIALOGUE[index].speaker] - (reducedMotion ? 0 : 300)
          await until(() => [...h.timers.values()].some((timer) => timer.ms === remainder))
          assert.equal(h.calls.filter(([kind]) => kind === 'speak').length, before + index)
          h.expire(remainder)
        }
        await until(() => h.calls.filter(([kind]) => kind === 'speak').length === before + index + 1)
        h.emit(h.sessions.at(-2 + index % 2), EVENTS.started)
        h.emit(h.sessions.at(-2 + index % 2), EVENTS.ended)
      }
      if (!reducedMotion) {
        await until(() => h.view.status === 'Finishing feedback...')
        h.expire(150)
      }
      await run
      assert.equal(h.view.status, 'Feedback Complete')
      assert.equal(h.view.caption, TEST_DIALOGUE[3].text)
      assert.equal(h.timers.size, 0)
    }
    await playConfigured(false)
    await playConfigured(true)
    assert.deepEqual(h.calls.filter(([kind]) => kind === 'tts').map((call) => call[1]), TEST_DIALOGUE)
    h.controller.dispose()
  }
})

test('Stop during the conversational gap cancels the next turn and cleans sessions', async () => {
  const h = harness({ speechTiming: true })
  await h.controller.prepare(); const run = h.controller.play()
  await until(() => h.sessions[0]?.sent.length === 1)
  h.emit(h.sessions[0], EVENTS.started)
  h.emit(h.sessions[0], EVENTS.ended)
  await until(() => [...h.timers.values()].some((timer) => timer.ms === SPEECH_CONFIG.turnDelayMs.Student))
  h.controller.stop()
  await run
  assert.equal(h.calls.filter(([kind]) => kind === 'speak').length, 1)
  assert.equal(h.timers.size, 0)
  assert.ok(h.sessions.every((session) => session.stops === 1 && session.interrupts === 1))
  assert.ok(Object.values(h.videos).every((video) => video.muted && video.srcObject === null))
  h.controller.dispose()
})

async function reachCompletionFade(h, offset = 0) {
  for (let index = 0; index < 4; index++) {
    for (let fade = 0; fade < 2; fade++) {
      await until(() => [...h.timers.values()].some((timer) => timer.ms === 150))
      h.expire(150)
    }
    await until(() => h.calls.filter(([kind]) => kind === 'speak').length === offset + index + 1)
    const active = h.sessions.at(-2 + index % 2)
    h.emit(active, EVENTS.started)
    h.emit(active, EVENTS.ended)
  }
  await until(() => h.view.status === 'Finishing feedback...')
}

function assertPreserved(h) {
  assert.equal(h.videos.Student.style.opacity, '1')
  assert.ok(h.videos.Student.srcObject)
  assert.ok(h.sessions.every((session) => session.stops === 1))
}

function assertDetached(h) {
  assert.ok(Object.values(h.videos).every((video) =>
    video.muted && video.style.opacity === '0' && video.srcObject === null &&
    video.pauses > 0 && video.loads > 0 && video.removed.includes('src')))
  assert.ok(h.sessions.every((session) => session.tracks.every((track) => track.stops === 1)))
}

test('completion retains the frame, occurs once, and rapid Replay uses only cached PCM', async () => {
  const h = harness({ reducedMotion: false })
  await h.controller.prepare(); const run = h.controller.play()
  await reachCompletionFade(h)
  const old = [...h.sessions]
  assert.equal(h.view.canReplay, true)
  assert.ok(h.videos.Student.srcObject) // Retain frames only while fading out.
  assert.equal(h.videos.Student.style.opacity, '1')
  assert.ok(old.every((session) => session.stops === 0))
  h.emit(old[1], EVENTS.ended, 'duplicate-final')
  h.emit(old[1], EVENTS.ended, 'duplicate-final')
  h.expire(150)
  await run
  assertPreserved(h)
  assert.equal(h.view.status, 'Feedback Complete')
  assert.equal(h.view.canReplay, true)
  assert.equal(h.view.canStop, false)
  assert.equal(h.calls.filter(([kind]) => kind === 'frame').length, 1)
  assert.equal(h.calls.find(([kind]) => kind === 'frame')[1], h.videos.Student)
  assert.equal(h.view.caption, TEST_DIALOGUE[3].text)
  assert.equal(h.view.speaker, 'Student')
  assert.equal(h.view.turn, 4)
  assert.equal(h.views.filter((view) => view.status === 'Feedback Complete').length, 1)
  assert.equal(h.timers.size, 0)
  const replay = h.controller.replay()
  assert.notEqual(h.view.status, 'Feedback Complete')
  const repeatedClick = h.controller.replay()
  h.emit(old[1], EVENTS.ended, 'late-final')
  await reachCompletionFade(h, 4)
  h.expire(150)
  await Promise.all([replay, repeatedClick])
  assert.equal(h.sessions.length, 4)
  assert.equal(h.calls.filter(([kind]) => kind === 'tts').length, 4)
  assert.equal(h.calls.filter(([kind]) => kind === 'speak').length, 8)
  assert.equal(h.views.filter((view) => view.status === 'Feedback Complete').length, 2)
  assertPreserved(h)
  h.controller.dispose()
})

test('Stop during final fade prevents stale completion after Replay begins', async () => {
  const h = harness({ reducedMotion: false })
  await h.controller.prepare(); const run = h.controller.play()
  await reachCompletionFade(h)
  const staleFade = [...h.timers.values()].find((timer) => timer.ms === 150).fn
  h.controller.stop()
  await run
  assert.equal(h.view.status, 'Stopped')
  assert.equal(h.timers.size, 0)
  assertDetached(h)
  const replay = h.controller.replay()
  staleFade() // Simulate a callback already queued when Stop cancelled it.
  await until(() => h.sessions.length === 4)
  assert.notEqual(h.view.status, 'Feedback Complete')
  assert.equal(h.views.filter((view) => view.status === 'Feedback Complete').length, 0)
  h.controller.stop()
  await replay
  h.controller.dispose()
})

test('unmount during completion suppresses stale UI updates', async () => {
  const h = harness({ reducedMotion: false })
  await h.controller.prepare(); const run = h.controller.play()
  await reachCompletionFade(h)
  const staleFade = [...h.timers.values()].find((timer) => timer.ms === 150).fn
  const updates = h.views.length
  h.controller.dispose()
  staleFade()
  await run
  assert.equal(h.views.length, updates)
  assertDetached(h)
  assert.equal(h.timers.size, 0)
})

test('media cleanup continues for both elements even if one track or pause throws', async () => {
  const h = harness()
  await h.controller.prepare()
  const run = h.controller.play()
  await until(() => h.sessions[0]?.sent.length === 1)
  h.sessions[0].tracks[0].stop = () => { throw new Error('already stopped') }
  h.videos.Professor.pause = () => { throw new Error('unavailable') }
  h.controller.stop()
  assert.ok(h.sessions.every((session) => session.stops === 1))
  assert.equal(h.sessions[0].tracks[1].stops, 1)
  assert.ok(h.sessions[1].tracks.every((track) => track.stops === 1))
  assert.ok(Object.values(h.videos).every((video) => video.srcObject === null && video.loads === 1))
  assert.equal(h.view.status, 'Stopped')
  await run
  h.controller.dispose()
})

test('completion retains the visible avatar through 300ms and 600ms before closing sessions', async () => {
  const h = harness({ reducedMotion: false, realCompletion: true })
  await h.controller.prepare(); const run = h.controller.play()
  await reachCompletionFade(h)
  assert.equal(h.videos.Student.style.opacity, '1')
  assert.ok(h.videos.Student.srcObject)
  assert.ok(h.sessions.every((session) => session.stops === 0))
  h.expire(300)
  await until(() => [...h.timers.values()].some((timer) => timer.ms === 600))
  assert.equal(h.videos.Student.style.opacity, '1')
  assert.equal(h.videos.Student.style.transitionDuration ?? '', '')
  assert.ok(h.videos.Student.srcObject)
  assert.ok(h.sessions.every((session) => session.stops === 0))
  assert.notEqual(h.view.status, 'Feedback Complete')
  h.expire(600)
  await run
  assertPreserved(h)
  assert.equal(h.view.status, 'Feedback Complete')
  assert.equal(h.videos.Student.style.transitionDuration ?? '', '')
  h.controller.dispose()
})

test('Stop and Replay cancel either completion timer without stale UI changes', async () => {
  for (const phase of ['hold', 'fade']) {
    for (const action of ['stop', 'replay']) {
      const h = harness({ reducedMotion: false, realCompletion: true })
      await h.controller.prepare(); const run = h.controller.play()
      await reachCompletionFade(h)
      if (phase === 'fade') {
        h.expire(300)
        await until(() => [...h.timers.values()].some((timer) => timer.ms === 600))
      }
      const duration = phase === 'hold' ? 300 : 600
      const stale = [...h.timers.values()].find((timer) => timer.ms === duration).fn
      const next = h.controller[action]()
      if (action === 'replay') await h.controller.replay() // Rapid second click is ignored.
      stale()
      await run
      if (action === 'replay') {
        await until(() => h.sessions.length === 4)
        assert.equal(h.calls.filter(([kind]) => kind === 'tts').length, 4)
      }
      assert.equal(h.views.filter((view) => view.status === 'Feedback Complete').length, 0)
      h.controller.stop()
      await next
      assert.equal(h.timers.size, 0)
      h.controller.dispose()
    }
  }
})
