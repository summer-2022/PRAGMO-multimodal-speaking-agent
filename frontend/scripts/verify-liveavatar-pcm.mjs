import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import * as esm from '../node_modules/@heygen/liveavatar-web-sdk/lib/index.esm.js'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

// The SDK names its CommonJS bundle .js within a type:module package.
// Evaluate that bundle as CommonJS without changing any installed files.
const cjsUrl = new URL('../node_modules/@heygen/liveavatar-web-sdk/lib/index.cjs.js', import.meta.url)
const cjs = {}
runInNewContext(await readFile(cjsUrl, 'utf8'), {
  exports: cjs, require: createRequire(cjsUrl),
  WebSocket: { OPEN: 1 }, btoa, atob, console, crypto: globalThis.crypto,
})

// No constructor, credentials, media devices, or network: exercise the real
// repeatAudio -> sendCommandEvent -> WebSocket serialization path.
for (const [name, sdk] of [['ESM', esm], ['CommonJS', cjs]]) {
  function mockSession() {
    const session = Object.create(sdk.LiveAvatarSession.prototype)
    EventEmitter.call(session)
    session._state = sdk.SessionState.CONNECTED
    const messages = []
    session._sessionEventSocket = {
      readyState: 1,
      send: (json) => messages.push(JSON.parse(json)),
    }
    return { session, messages }
  }

  test(`${name}: one-second PCM is Base64 encoded per chunk and round-trips`, () => {
    // Include all byte values, especially NUL and non-ASCII bytes.
    const pcm = Buffer.from(Array.from({ length: 48000 }, (_, i) => i % 256))
    const { session, messages } = mockSession()
    const commandId = session.repeatAudio(pcm.toString('latin1'))
    assert.equal(typeof commandId, 'string')
    assert.deepEqual(messages.map((m) => m.type), [
      'agent.speak', 'agent.speak', 'agent.speak_end',
    ])
    const chunks = messages.slice(0, -1).map(({ audio }) => {
      assert.match(audio, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      const bytes = Buffer.from(audio, 'base64')
      assert.equal(bytes.toString('base64'), audio)
      return bytes
    })
    assert.deepEqual(chunks.map((b) => b.length), [19200, 28800])
    assert.deepEqual(Buffer.concat(chunks), pcm)
    assert.equal(new Set(messages.map((m) => m.event_id)).size, 1)
    assert.equal('audio' in messages.at(-1), false)
  })

  test(`${name}: LITE speaking callbacks have the documented payload`, () => {
    const { session } = mockSession()
    for (const [wireType, eventType] of [
      ['agent.speak_started', sdk.AgentEventsEnum.AVATAR_SPEAK_STARTED],
      ['agent.speak_ended', sdk.AgentEventsEnum.AVATAR_SPEAK_ENDED],
    ]) {
      let received
      session.once(eventType, (event) => { received = event })
      session.handleWebSocketMessage({ data: JSON.stringify({
        type: wireType, event_id: 'offline-event',
      }) })
      assert.deepEqual({ ...received }, { event_type: eventType, event_id: 'offline-event' })
    }
  })
}

test('standalone SDK implementation also contains the serialization fix', async () => {
  const source = await readFile(new URL(
    '../node_modules/@heygen/liveavatar-web-sdk/lib/LiveAvatarSession/LiveAvatarSession.js',
    import.meta.url,
  ), 'utf8')
  assert.match(source, /audio: btoa\(audioChunk\),/)
  assert.doesNotMatch(source, /audio: audioChunk,/)
})
