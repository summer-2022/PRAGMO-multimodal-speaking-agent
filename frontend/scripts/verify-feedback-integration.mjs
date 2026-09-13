import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { mountFeedbackController } from '../src/liveavatar/mountFeedbackController.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick() }
  assert.fail('Expected integration state was not reached')
}
function dialogue(label) {
  return ['Professor', 'Student', 'Professor', 'Student'].map((speaker, index) => ({
    speaker, text: `  ${label}: turn ${index + 1}—punctuation?!\nDo not normalize.  `,
  }))
}
function setup(input, fetchOverride) {
  const calls = [], views = []
  const options = {
    dialogue: input, apiUrl: 'http://offline.invalid', log() {},
    onChange: (view) => views.push(view),
    createSession() { assert.fail('Automatic PCM preparation must never construct sessions') },
    videos: Object.fromEntries(['Professor', 'Student'].map((role) => [role, {
      style: {}, muted: true, srcObject: null, pause() {}, removeAttribute() {}, load() {},
    }])),
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), signal: init.signal })
      if (fetchOverride) return fetchOverride(url, init)
      return { ok: true, json: async () => ({ audio: btoa('\x00\x01') }) }
    },
  }
  return { calls, views, options }
}

test('StrictMode setup/cleanup/setup generates only four clips and no tokens', async () => {
  const h = setup(dialogue('SP1 result'))
  const probe = mountFeedbackController(h.options)
  probe.dispose()
  const active = mountFeedbackController(h.options)
  await until(() => h.views.at(-1)?.canPlay)
  assert.equal(h.calls.length, 4)
  assert.ok(h.calls.every((call) => call.url === 'http://offline.invalid/tts'))
  assert.deepEqual(h.calls.map((call) => call.body), h.options.dialogue)
  active.dispose()
})

test('each analysis result, including identical text, owns a new preparation cache', async () => {
  for (const input of [dialogue('First'), dialogue('First'), dialogue('Second')]) {
    const h = setup(input)
    const mount = mountFeedbackController(h.options)
    await until(() => h.views.at(-1)?.canPlay)
    assert.deepEqual(h.calls.map((call) => call.body), input)
    assert.equal(h.calls.length, 4)
    mount.dispose()
  }
})

test('changing dialogue or leaving the page aborts preparation and ignores late data', async () => {
  let resolveFetch
  const old = setup(dialogue('Old'), () => new Promise((resolve) => { resolveFetch = resolve }))
  const previous = mountFeedbackController(old.options)
  await until(() => resolveFetch)
  previous.dispose()
  const updateCount = old.views.length
  assert.ok(old.calls[0].signal.aborted)
  const next = setup(dialogue('New'))
  const active = mountFeedbackController(next.options)
  resolveFetch({ ok: true, json: async () => ({ audio: btoa('\x00\x01') }) })
  await until(() => next.views.at(-1)?.canPlay)
  assert.equal(old.views.length, updateCount)
  assert.equal(old.calls.length, 1)
  assert.equal(next.calls.length, 4)
  active.dispose()
})

test('invalid session dialogue reports an error without TTS or token requests', async () => {
  for (const input of [undefined, [], dialogue('Bad').reverse()]) {
    const h = setup(input)
    const mount = mountFeedbackController(h.options)
    await until(() => h.views.length)
    assert.equal(h.views.at(-1).status, 'Invalid dialogue')
    assert.equal(h.calls.length, 0)
    mount.dispose()
  }
})

test('App uses a new result identity, gates SP2 on completion, and has no render-video call', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /generate-video|generateVideo|TEST_DIALOGUE/)
  assert.match(app, /key=\{feedbackRequest.id\}/)
  assert.match(app, /id: \(previous\?\.id \?\? 0\) \+ 1/)
  assert.match(app, /Boolean\(analysis && feedbackComplete\)/)
  assert.match(app, /onClick=\{\(\) => setPage\('sp2'\)\}/)
  assert.match(app, /type: 'start_sp2', sp1_transcript: transcript, analysis: analysis/)
  const validation = await readFile(new URL('../src/liveavatar/dialogue.js', import.meta.url), 'utf8')
  assert.doesNotMatch(validation, /TEST_DIALOGUE|Hi, Jiwon/)
})


test('completed controls preserve the viewport and use the primary green without Stop', async () => {
  const source = await (await import('node:fs/promises')).readFile(
    new URL('../src/components/LiveAvatarFeedback.jsx', import.meta.url), 'utf8')
  assert.ok(!source.includes('btn-stop'))
  assert.ok(source.includes("view.status === 'Feedback Complete'"))
  const css = await readFile(new URL('../src/components/LiveAvatarFeedback.css', import.meta.url), 'utf8')
  assert.match(css, /\.liveavatar-feedback-status\s*\{[^}]*color: #2ecc71;/)
  assert.ok(!source.includes('liveavatar-feedback-caption'))
  assert.ok(source.includes('view.turn || view.hasPlayed'))
  assert.ok(source.includes('drawImage(video, 0, 0)'))
  assert.ok(source.includes('Replay Feedback'))
})
