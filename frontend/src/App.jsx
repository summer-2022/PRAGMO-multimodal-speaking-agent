import { useState, useRef } from 'react'
import './App.css'
import professorImage from './assets/RTS_professor.png'

function App() {
  const [isConnected, setIsConnected] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [micPermission, setMicPermission] = useState('prompt') // 'prompt' | 'granted' | 'denied'
  const [transcript, setTranscript] = useState([])
  const [analysis, setAnalysis] = useState(null)
  const [videoUrl, setVideoUrl] = useState(null)
  const [isGeneratingVideo, setIsGeneratingVideo] = useState(false)
  const [videoError, setVideoError] = useState(null)
  const [isSp2Active, setIsSp2Active] = useState(false)
  const [isSp2Speaking, setIsSp2Speaking] = useState(false)
  const [sp2Transcript, setSp2Transcript] = useState([])
  const [evaluation, setEvaluation] = useState(null)
  const [page, setPage] = useState('intro')
  const [selectedScenario, setSelectedScenario] = useState('')
  const SHOW_TRANSCRIPT = false
  const streamRef = useRef(null)
  const wsRef = useRef(null)
  const recorderRef = useRef(null)
  const audioCtxRef = useRef(null)
  const nextPlayTimeRef = useRef(0)
  const pendingStopRef = useRef(false)

  // Decode a base64 PCM16 string and schedule it for gapless playback
  function playPcm16Chunk(base64) {
    const ctx = audioCtxRef.current
    if (!ctx) { console.warn('[audio] AudioContext not ready'); return }

    if (ctx.state === 'suspended') {
      ctx.resume().then(() => console.log('[audio] AudioContext resumed'))
    }

    // Decode base64 → Uint8Array
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

    // PCM16 little-endian → Float32
    const samples = bytes.length / 2
    const float32 = new Float32Array(samples)
    const view = new DataView(bytes.buffer)
    for (let i = 0; i < samples; i++) {
      float32[i] = view.getInt16(i * 2, true) / 32768
    }

    // Debug: log peak amplitude to confirm non-silent audio
    let peak = 0
    for (let i = 0; i < float32.length; i++) {
      if (Math.abs(float32[i]) > peak) peak = Math.abs(float32[i])
    }
    console.log(`[audio] chunk: ${samples} samples, peak=${peak.toFixed(4)}, ctx.state=${ctx.state}`)

    // Buffer uses 24000 Hz (the incoming PCM rate); ctx uses native device rate —
    // the browser resamples automatically when they differ.
    const buffer = ctx.createBuffer(1, samples, 24000)
    buffer.copyToChannel(float32, 0)

    const source = ctx.createBufferSource()
    source.buffer = buffer

    // GainNode at 1.0 ensures the signal reaches the destination
    const gain = ctx.createGain()
    gain.gain.value = 1.0
    source.connect(gain)
    gain.connect(ctx.destination)

    // If the schedule clock has fallen behind (first chunk or gap), push it forward
    if (nextPlayTimeRef.current < ctx.currentTime) {
      nextPlayTimeRef.current = ctx.currentTime + 0.05
    }
    source.start(nextPlayTimeRef.current)
    nextPlayTimeRef.current += buffer.duration
  }

  const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8000/ws'

  async function requestMicPermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      setMicPermission('granted')
      return true
    } catch {
      setMicPermission('denied')
      return false
    }
  }

  async function startConversation() {
    if (micPermission !== 'granted') {
      const ok = await requestMicPermission()
      if (!ok) return
    }
    setIsConnected(true)
    setIsSpeaking(true)
    setTranscript([])

    audioCtxRef.current = new AudioContext()
    nextPlayTimeRef.current = 0
    // Browsers may suspend AudioContext even on a user-gesture path — resume explicitly
    audioCtxRef.current.resume().then(() =>
      console.log('[audio] AudioContext state after resume:', audioCtxRef.current.state)
    )

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    ws.binaryType = 'arraybuffer'

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)

      if (msg.role && msg.text) {
        setTranscript(prev => [...prev, { role: msg.role, text: msg.text }])
      }
      if (msg.type === 'user_speaking') setIsSpeaking(true)
      if (msg.type === 'ai_speaking') setIsSpeaking(false)
      if (msg.type === 'audio.delta') {
        console.log(`[audio] received audio.delta, ${msg.audio?.length ?? 0} base64 chars`)
        playPcm16Chunk(msg.audio)
      }
      if (msg.type === 'audio.done') console.log('[audio] audio.done received')
      if (msg.type === 'analysis_result') {
         //console.log("ANALYSIS RESULT:", msg.data) // Debug log to inspect the structure of the analysis result

        setAnalysis(msg.data)
        if (pendingStopRef.current) {
          pendingStopRef.current = false
          cleanupSession()
        }
        const videoDialogue = msg.data?.video_dialogue
        if (videoDialogue) {
          generateVideo(videoDialogue)
        }
      }
    }

    ws.onclose = () => {
      setIsConnected(false)
      setIsSpeaking(false)
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'set_scenario', scenario: selectedScenario }))

      const recorder = new MediaRecorder(streamRef.current)
      recorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data)
        }
      }

      recorder.start(100) // send chunks every 100ms
    }
  }

  function cleanupSession() {
    setIsConnected(false)
    setIsSpeaking(false)
    if (recorderRef.current) {
      recorderRef.current.stop()
      recorderRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close()
      audioCtxRef.current = null
    }
  }

  const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

  async function generateVideo(videoDialogue) {
    if (!videoDialogue) return
    setIsGeneratingVideo(true)
    setVideoError(null)
    setVideoUrl(null)
    try {
      const res = await fetch(`${API_URL}/generate-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_dialogue: videoDialogue }),
      })
      if (!res.ok) throw new Error(`Server error: ${res.status}`)
      const data = await res.json()
      setVideoUrl(data.video_url)
    } catch (err) {
      setVideoError(err.message)
    } finally {
      setIsGeneratingVideo(false)
    }
  }

  async function startSp2() {
    // Always re-acquire mic stream (SP1 stream was stopped during cleanup)
    const ok = await requestMicPermission()
    if (!ok) return

    setIsSp2Active(true)
    setIsSp2Speaking(true)
    setSp2Transcript([])

    audioCtxRef.current = new AudioContext()
    nextPlayTimeRef.current = 0
    audioCtxRef.current.resume()

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws
    ws.binaryType = 'arraybuffer'

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (msg.role && msg.text) {
        setSp2Transcript(prev => [...prev, { role: msg.role, text: msg.text }])
      }
      if (msg.type === 'user_speaking') setIsSp2Speaking(true)
      if (msg.type === 'ai_speaking') setIsSp2Speaking(false)
      if (msg.type === 'audio.delta') playPcm16Chunk(msg.audio)
      if (msg.type === 'audio.done') console.log('[sp2 audio] audio.done received')
      if (msg.type === 'evaluation_result') {
        setEvaluation(msg.data)
        cleanupSession()
        setIsSp2Active(false)
        setIsSp2Speaking(false)
      }
    }

    ws.onclose = () => {
      setIsSp2Active(false)
      setIsSp2Speaking(false)
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'start_sp2', sp1_transcript: transcript, analysis: analysis }))

      const recorder = new MediaRecorder(streamRef.current)
      recorderRef.current = recorder
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(e.data)
        }
      }
      recorder.start(100)
    }
  }

  function stopSp2() {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'finish_sp2' }))
    }
    setPage('evaluation') // navigate immediately; evaluation arrives in background
    // Keep WS open — cleanupSession runs once evaluation_result is received
  }

  function normalizeLine(text) {
    return (text || '').trim().replace(/\s+/g, ' ')
  }

  function isHighlightedLine(text, candidates = []) {
    const normalized = normalizeLine(text)
    return candidates.some(candidate => normalizeLine(candidate) === normalized)
  }

  const SCENARIOS = {
    professor_extension: {
      label: 'Professor Extension Request',
      description: 'You need to ask your professor for a short extension for an assignment. Explain your situation and politely ask whether it is possible.',
    },
  }

  function startPractice() {
    setTranscript([])
    setAnalysis(null)
    setVideoUrl(null)
    setVideoError(null)
    setIsGeneratingVideo(false)
    setSp2Transcript([])
    setEvaluation(null)
    setIsSp2Active(false)
    setIsSp2Speaking(false)
    setPage('sp1')
  }

  function stopConversation() {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      pendingStopRef.current = true
      ws.send(JSON.stringify({ type: 'finish_sp1' }))
      // Keep WS open — cleanupSession runs once analysis_result is received
    } else {
      cleanupSession()
    }
    setPage('video') // navigate immediately; analysis arrives in background
  }

  const ACCENT = '#2ecc71'
  const pageOrder = ['sp1', 'video', 'sp2', 'evaluation']
  const stepLabels = ['First Conversation', 'AI Video Feedback', 'Retry Conversation', 'Evaluation']
  const currentStep = pageOrder.indexOf(page)

  // Geometry: 600px inner wrapper, 4 flex:1 steps → each step = 150px.
  // Circle centers: 75, 225, 375, 525px from left.
  // Track: left 75px, right 75px (span = 450px).
  // Active line grows by one step-width (150px) per completed step.
  const STEP_WIDTH = 150        // 600px / 4 steps
  const CIRCLE_OFFSET = 75      // half of STEP_WIDTH = circle center of first step
  const TRACK_SPAN = 450        // STEP_WIDTH * 3 = distance between first and last circle center

  const progressBar = (
    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '4px' }}>
      <div style={{ width: '600px', position: 'relative', display: 'flex' }}>

        {/* Grey baseline track */}
        <div style={{
          position: 'absolute', top: '11px',
          left: `${CIRCLE_OFFSET}px`, width: `${TRACK_SPAN}px`,
          height: '2px', background: '#e0e0e0', zIndex: 0,
        }} />

        {/* Active green track — grows exactly one STEP_WIDTH per completed step */}
        {currentStep > 0 && (
          <div style={{
            position: 'absolute', top: '11px',
            left: `${CIRCLE_OFFSET}px`, width: `${currentStep * STEP_WIDTH}px`,
            height: '2px', background: ACCENT, zIndex: 0,
          }} />
        )}

        {stepLabels.map((label, i) => (
          <div key={i} style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', gap: '6px',
            position: 'relative', zIndex: 1,
          }}>
            <div style={{
              width: '24px', height: '24px', borderRadius: '50%',
              background: i <= currentStep ? ACCENT : '#e0e0e0',
              color: i <= currentStep ? '#fff' : '#aaa',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 700, fontSize: '0.75rem', flexShrink: 0,
            }}>{i + 1}</div>
            <span style={{
              fontSize: '0.72rem', textAlign: 'center',
              whiteSpace: 'normal', lineHeight: '1.3', width: '100%',
              color: i === currentStep ? ACCENT : i < currentStep ? '#555' : '#aaa',
              fontWeight: i === currentStep ? 700 : 400,
            }}>{label}</span>
          </div>
        ))}

      </div>
    </div>
  )

  if (page === 'intro') {
    const scenario = selectedScenario ? SCENARIOS[selectedScenario] : null
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        fontFamily: 'sans-serif',
        background: '#f6f7fb',
        paddingTop: '120px',
        padding: '120px 24px 24px',
      }}>
        <div style={{
          background: '#fff',
          borderRadius: '18px',
          padding: '56px 48px',
          maxWidth: '680px',
          width: '100%',
          boxShadow: '0 12px 40px rgba(0,0,0,0.08)',
          display: 'flex',
          flexDirection: 'column',
          gap: '30px',
        }}>
          {/* Title */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <h1 style={{ margin: 0, fontSize: '1.9rem', fontWeight: 700, lineHeight: 1.2, textAlign: 'center' }}>
              Realtime Speaking Agent
            </h1>
            <p style={{ margin: '12px auto 8px', fontSize: '1rem', fontWeight: 600, color: '#555', textAlign: 'center', maxWidth: '520px' }}>
              Practice pragmatic speaking with AI video feedback
            </p>
          </div>

          {/* Flow hint */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '0.85rem', color: ACCENT, marginBottom: '-12px' }}>
            {['Conversation', 'Video Feedback', 'Retry', 'Evaluation'].map((step, i, arr) => (
              <span key={step} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span>{step}</span>
                {i < arr.length - 1 && <span style={{ color: ACCENT }}>→</span>}
              </span>
            ))}
          </div>

          {/* Scenario selector */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '460px', width: '100%', margin: '0 auto' }}>
            <label style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#999' }}>
              Scenario
            </label>
            <select
              value={selectedScenario}
              onChange={e => setSelectedScenario(e.target.value)}
              style={{
                padding: '12px 14px',
                fontSize: '1rem',
                border: '1px solid #ddd',
                borderRadius: '10px',
                background: '#fff',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              <option value="" disabled>Select a scenario</option>
              {Object.entries(SCENARIOS).map(([key, s]) => (
                <option key={key} value={key}>{s.label}</option>
              ))}
            </select>
            {scenario && (
              <p style={{ margin: 0, fontSize: '0.95rem', color: '#444', lineHeight: 1.6, background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '14px 16px' }}>
                {scenario.description}
              </p>
            )}
          </div>

          {/* Start button */}
          <button
            onClick={startPractice}
            disabled={!selectedScenario}
            style={{
              padding: '12px 28px',
              fontSize: '1rem',
              fontWeight: 700,
              border: 'none',
              borderRadius: '8px',
              background: selectedScenario ? '#2ecc71' : '#d1d5db',
              color: selectedScenario ? '#fff' : '#9ca3af',
              cursor: selectedScenario ? 'pointer' : 'not-allowed',
              transition: 'background 0.2s',
              alignSelf: 'center',
            }}
            onMouseEnter={e => { if (selectedScenario) e.currentTarget.style.background = '#27ae60' }}
            onMouseLeave={e => { if (selectedScenario) e.currentTarget.style.background = '#2ecc71' }}
          >
            Start Practice
          </button>
        </div>
      </div>
    )
  }

  if (page === 'sp1') {
    return (
      <div className="speaking-app">
        {progressBar}
        <h1>First Conversation</h1>

        <div className="mic-status" style={{ margin: '2px 0 4px' }}>
          {micPermission === 'denied' && (
            <p className="permission-error">Microphone access denied. Please allow it in your browser settings.</p>
          )}
          {!isConnected && (
            <p style={{ margin: '-8px 0 0', color: '#888', fontSize: '0.95rem' }}>Realtime AI Speaking</p>
          )}
          {isConnected && micPermission === 'granted' && (
            <p className="permission-ok" style={{ margin: 0, fontSize: '0.8rem', lineHeight: 1 }}>Microphone ready</p>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '8px 0 18px' }}>
          <img
            src={professorImage}
            alt="Professor"
            style={{ width: 'min(560px, 90vw)', height: 'auto', borderRadius: '16px' }}
          />
          <p style={{ margin: '8px 0 0', fontSize: '0.82rem', color: '#666', fontStyle: 'italic' }}>
            Professor Khan's Office
          </p>
        </div>

        <div className="speaking-indicator" style={{ justifyContent: 'center', marginTop: isConnected ? '0' : '-14px' }}>
          <div className={`pulse ${isSpeaking && isConnected ? 'active' : ''}`} />
          <span>{isConnected ? (isSpeaking ? 'Speaking...' : 'Connected') : 'Idle'}</span>

        </div>

        <div className="controls" style={{ justifyContent: 'center' }}>
          {!isConnected ? (
            <button className="btn-start" onClick={startConversation}>
              Start Conversation
            </button>
          ) : (
            <button className="btn-stop" onClick={stopConversation}>
              Stop Conversation
            </button>
          )}
        </div>

        {SHOW_TRANSCRIPT && (
          <div className="transcript-area">
            <h2>Transcript</h2>
            {transcript.length === 0 ? (
              <p className="transcript-placeholder">Transcript will appear here...</p>
            ) : (
              <ul>
                {transcript.map((line, i) => (
                  <li key={i} className={`transcript-line ${line.role}`}>
                    <span className="role">{line.role === 'user' ? 'You' : 'AI'}:</span> {line.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    )
  }

  if (page === 'video') {
    const canProceed = analysis // && !isGeneratingVideo
    return (
      <div className="speaking-app">
        {progressBar}
        <style>{`@keyframes vf-spin { to { transform: rotate(360deg); } }`}</style>

        <h1 style={{ marginBottom: 0 }}>AI Video Feedback</h1>

        {/* 1 — Video Feedback card */}
        <div style={{
          border: `1.5px solid ${isGeneratingVideo ? '#d1fae5' : videoUrl ? '#2ecc71' : '#e5e7eb'}`,
          borderRadius: '14px',
          padding: '28px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          background: isGeneratingVideo ? '#f0fdf4' : '#fff',
          transition: 'border-color 0.4s, background 0.4s',
        }}>
          {isGeneratingVideo && (
            <>
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '10px', textAlign: 'center' }}>
                <div style={{
                  width: '20px',
                  height: '20px',
                  border: '2px solid #d1fae5',
                  borderTop: '2px solid #2ecc71',
                  borderRadius: '50%',
                  animation: 'vf-spin 0.8s linear infinite',
                  flexShrink: 0,
                }} />
                <span style={{ fontWeight: 600, fontSize: '0.95rem', color: '#166534' }}>
                  Generating your feedback video...
                </span>
              </div>
              <p style={{ margin: 0, fontSize: '0.88rem', color: '#4b7c60', lineHeight: 1.65 }}>
                Your personalized feedback video is being prepared.<br />
                While you wait, please review the analysis below.
              </p>
            </>
          )}

          {videoError && (
            <p style={{ margin: 0, color: '#c0392b', fontSize: '0.92rem', lineHeight: 1.5 }}>
              Error: {videoError}
            </p>
          )}

          {videoUrl && !isGeneratingVideo && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <p style={{ margin: 0, marginBottom: '8px', fontSize: '0.85rem', color: '#6b7280', textAlign: 'center', lineHeight: 1.5 }}>
                Watch the feedback video, then retry the conversation.
              </p>
              <video
                src={videoUrl}
                controls
                style={{ width: '100%', borderRadius: '10px', display: 'block', boxShadow: '0 2px 12px rgba(0,0,0,0.08)' }}
              />
            </div>
          )}
        </div>

        {/* Optional: Display the video dialogue script if available in the analysis result */}
        {analysis?.video_dialogue && (
          <div
            style={{
              marginTop: "20px",
              padding: "16px",
              background: "#f8fafc",
              border: "1px solid #e5e7eb",
              borderRadius: "12px"
            }}
          >
            <h3 style={{ marginTop: 0 }}>Video Script Preview</h3>

            {analysis.video_dialogue.map((line, idx) => (
              <p key={idx} style={{ margin: "8px 0" }}>
                <strong>{line.speaker}:</strong> {line.text}
              </p>
            ))}
          </div>
        )}

        {/* 2 — Analysis card */}
        {!analysis && (
          <p style={{ color: '#9ca3af', fontSize: '0.92rem', margin: 0 }}>Analyzing your conversation…</p>
        )}

        {analysis && (
          <div style={{
            border: '1px solid #e5e7eb',
            borderRadius: '14px',
            padding: '28px',
            display: 'flex',
            flexDirection: 'column',
            gap: '22px',
            background: '#fff',
            textAlign: 'left',
          }}>
            <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: '#111', letterSpacing: '-0.01em', textAlign: 'center' }}>
              Analysis
            </h2>

            <div>
              <h3 style={{ margin: '0 0 10px', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#22c55e' }}>
                Focus Areas
              </h3>
              <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', listStyleType: 'disc' }}>
                {analysis.focus_areas.map((item, i) => (
                  <li key={i} style={{ fontSize: '0.93rem', color: '#374151', lineHeight: 1.6, paddingLeft: '4px' }}>{item}</li>
                ))}
              </ul>
            </div>

            <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: '18px' }}>
              <h3 style={{ margin: '0 0 10px', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#22c55e' }}>
                Key Issues
              </h3>
              {/* <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', listStyleType: 'disc' }}>
                {analysis?.issues?.map((item, i) => (
                  <li key={i} style={{ fontSize: '0.93rem', color: '#374151', lineHeight: 1.6, paddingLeft: '4px' }}>
                    {typeof item === 'string'
                      ? item
                      : <>{item.issue}{item.example && <span style={{ color: '#6b7280' }}> — {item.example}</span>}</>
                    }
                  </li>
                ))}
              </ul> */}

              <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '14px', listStyleType: 'none' }}>
                {(analysis?.issues || analysis?.["areas to improve"] || []).map((item, i) =>  (
                  <li key={i} style={{ fontSize: '0.93rem', color: '#374151', lineHeight: 1.6 }}>
                    
                    {/* Issue Type */}
                    <div style={{ fontWeight: 600 }}>
                      {i + 1}. {item.type || item.issue || 'Pragmatic issue'}
                    </div>

                    {/* Description */}
                    {item.description && (
                      <div style={{ marginTop: '4px', fontSize: '0.88rem', color: '#4b5563' }}>
                        {item.description}
                      </div>
                    )}

                    {/* Example */}
                    {item.example && (
                      <div style={{ marginTop: '6px' }}>
                        <span style={{ fontWeight: 500 }}>Example:</span>{' '}
                        <span style={{ color: '#6b7280' }}>"{item.example}"</span>
                      </div>
                    )}

                    {/* Fix */}
                    {item.fix && (
                      <div style={{ marginTop: '6px', color: '#10b981' }}>
                        <span style={{ fontWeight: 500 }}>Try:</span> {item.fix}
                      </div>
                    )}

                  </li>
                ))}
              </ul>
            </div>

            <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: '18px' }}>
              <h3 style={{ margin: '0 0 10px', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#22c55e' }}>
                Summary
              </h3>
              <p style={{ margin: 0, fontSize: '0.93rem', color: '#374151', lineHeight: 1.7, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '14px 16px' }}>
                {analysis.summary}
              </p>
            </div>
          </div>
        )}

        {/* 3 — Next action */}
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '4px' }}>
          <button
            className="btn-start"
            onClick={() => setPage('sp2')}
            disabled={!canProceed}
            style={{ opacity: canProceed ? 1 : 0.4, cursor: canProceed ? 'pointer' : 'not-allowed' }}
          >
            Start Retry Speaking
          </button>
        </div>
      </div>
    )
  }

  if (page === 'sp2') {
    return (
      <div className="speaking-app">
        {progressBar}
        <h1>Retry Conversation</h1>

        <div className="mic-status" style={{ margin: '2px 0 4px' }}>
          {micPermission === 'denied' && (
            <p className="permission-error">Microphone access denied. Please allow it in your browser settings.</p>
          )}
          {!isSp2Active && (
            <p style={{ margin: '-8px 0 0', color: '#888', fontSize: '0.95rem' }}>Realtime AI Speaking</p>
          )}
          {isSp2Active && micPermission === 'granted' && (
            <p className="permission-ok" style={{ margin: 0, fontSize: '0.8rem', lineHeight: 1 }}>Microphone ready</p>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '8px 0 18px' }}>
          <img
            src={professorImage}
            alt="Professor"
            style={{ width: 'min(560px, 90vw)', height: 'auto', borderRadius: '16px' }}
          />
          <p style={{ margin: '8px 0 0', fontSize: '0.82rem', color: '#666', fontStyle: 'italic' }}>
            Professor Khan's Office
          </p>
        </div>

        <div className="speaking-indicator" style={{ justifyContent: 'center', marginTop: isSp2Active ? '0' : '-14px' }}>
          <div className={`pulse ${isSp2Speaking && isSp2Active ? 'active' : ''}`} />
          <span>{isSp2Active ? (isSp2Speaking ? 'Speaking...' : 'Connected') : 'Idle'}</span>
        </div>

        <div className="controls" style={{ justifyContent: 'center' }}>
          {!isSp2Active ? (
            <button className="btn-start" onClick={startSp2}>
              Start Retry Speaking
            </button>
          ) : (
            <button className="btn-stop" onClick={stopSp2}>
              Stop Conversation
            </button>
          )}
        </div>

        {SHOW_TRANSCRIPT && (
          <div className="transcript-area">
            <h2>Transcript</h2>
            {sp2Transcript.length === 0 ? (
              <p className="transcript-placeholder">Transcript will appear here...</p>
            ) : (
              <ul>
                {sp2Transcript.map((line, i) => (
                  <li key={i} className={`transcript-line ${line.role}`}>
                    <span className="role">{line.role === 'user' ? 'You' : 'AI'}:</span> {line.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    )
  }

  if (page === 'evaluation') {
    return (
      <div className="speaking-app">
        {progressBar}
        <h1>Evaluation Results</h1>

        {!evaluation && (
          <p style={{ color: '#888', fontSize: '0.95rem' }}>Evaluating your session…</p>
        )}

        {evaluation && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div style={{ border: '1px solid #ddd', borderRadius: '10px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

              {/* Pragmatics Progress */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#888' }}>Pragmatics Progress</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', justifyContent: 'center' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                    <span style={{ fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#aaa' }}>SP1</span>
                    <span style={{ fontSize: '2.2rem', fontWeight: 700, color: '#10b981', lineHeight: 1 }}>
                      {evaluation.pragmatic_score_sp1}<span style={{ fontSize: '1rem', color: '#bbb', fontWeight: 400 }}>/5</span>
                    </span>
                  </div>
                  <span style={{ fontSize: '1.4rem', color: '#cbd5e1', fontWeight: 700 }}>→</span>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                    <span style={{ fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#aaa' }}>SP2</span>
                    <span style={{ fontSize: '2.2rem', fontWeight: 700, color: '#10b981', lineHeight: 1 }}>
                      {evaluation.pragmatic_score_sp2}<span style={{ fontSize: '1rem', color: '#bbb', fontWeight: 400 }}>/5</span>
                    </span>
                  </div>
                </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div>
                      <strong>SP1 (Before)</strong>
                      <p style={{ margin: 0 }}>
                        {evaluation.pragmatics_progress?.sp1 || '—'}
                      </p>
                    </div>

                    <div>
                      <strong>SP2 (After)</strong>
                      <p style={{ margin: 0 }}>
                        {evaluation.pragmatics_progress?.sp2 || '—'}
                      </p>
                    </div>

                    <div>
                      <strong>Why this matters</strong>
                      <p style={{ margin: 0 }}>
                        {evaluation.pragmatics_progress?.analysis || '—'}
                      </p>
                    </div>
                  </div>
              </div>

              <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: 0 }} />

              {/* Feedback Uptake */}
              {(() => {
                const label = evaluation.feedback_uptake_label
                const badgeColor = label === 'yes' ? '#16a34a' : label === 'partial' ? '#d97706' : '#dc2626'
                const badgeBg = label === 'yes' ? '#f0fdf4' : label === 'partial' ? '#fffbeb' : '#fef2f2'
                const badgeBorder = label === 'yes' ? '#bbf7d0' : label === 'partial' ? '#fde68a' : '#fecaca'
                const badgeText = label === 'yes' ? 'Yes Uptake' : label === 'partial' ? 'Partial Uptake' : 'No Uptake'
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#888' }}>Feedback Uptake</span>
                    <span style={{ display: 'inline-block', alignSelf: 'center', padding: '4px 12px', borderRadius: '999px', fontSize: '0.82rem', fontWeight: 700, color: badgeColor, background: badgeBg, border: `1px solid ${badgeBorder}` }}>
                      {badgeText}
                    </span>
                    <p style={{ margin: 0, fontSize: '0.95rem', color: '#444', lineHeight: 1.6 }}>{evaluation.feedback_uptake_reason}</p>
                  </div>
                )
              })()}

              <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: 0 }} />

              {/* Overall Summary */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#888' }}>Overall Summary</span>
                <p style={{ margin: 0, fontSize: '0.95rem', color: '#444', lineHeight: 1.6 }}>{evaluation.evaluation_summary}</p>
              </div>

            </div>

            {/* Expandable conversation trace */}
            <details style={{ border: '1px solid #ddd', borderRadius: '10px', overflow: 'hidden' }}>
              <summary style={{ padding: '14px 20px', cursor: 'pointer', fontWeight: 600, fontSize: '0.95rem', listStyle: 'none', display: 'flex', alignItems: 'center', gap: '8px', userSelect: 'none' }}>
                <span style={{ fontSize: '0.75rem', color: '#888' }}>▶</span> Show Conversation Details
              </summary>
              <div style={{ padding: '16px 20px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', maxWidth: '980px', margin: '0 auto' }}>

                <div style={{ border: '1px solid #e5e7eb', borderRadius: '10px', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <h3 style={{ margin: 0, fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280' }}>First Conversation</h3>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px', textAlign: 'left' }}>
                    {transcript.map((line, i) => {
                      const isProblematic = line.role === 'user' && isHighlightedLine(line.text, evaluation.problematic_lines_sp1)
                      return (
                        <li key={i} className={`transcript-line ${line.role}`} style={isProblematic ? { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', padding: '4px 8px' } : {}}>
                          <span className="role">{line.role === 'user' ? 'You' : 'Professor'}:</span> {line.text}
                          {isProblematic && <span style={{ marginLeft: '6px', color: '#dc2626' }}>❌</span>}
                        </li>
                      )
                    })}
                  </ul>
                </div>

                <div style={{ border: '1px solid #e5e7eb', borderRadius: '10px', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <h3 style={{ margin: 0, fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280' }}>Second Attempt</h3>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px', textAlign: 'left' }}>
                    {sp2Transcript.map((line, i) => {
                      const isImproved = line.role === 'user' && isHighlightedLine(line.text, evaluation.improved_lines_sp2)
                      return (
                        <li key={i} className={`transcript-line ${line.role}`} style={isImproved ? { background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', padding: '4px 8px' } : {}}>
                          <span className="role">{line.role === 'user' ? 'You' : 'Professor'}:</span> {line.text}
                          {isImproved && <span style={{ marginLeft: '6px', color: '#16a34a' }}>✅</span>}
                        </li>
                      )
                    })}
                  </ul>
                </div>

              </div>
            </details>
          </div>
        )}
      </div>
    )
  }
}

export default App
