import { useEffect, useRef, useState } from 'react'
import { LiveAvatarSession } from '@heygen/liveavatar-web-sdk'
import { mountFeedbackController } from '../liveavatar/mountFeedbackController'
import './LiveAvatarFeedback.css'

const INITIAL_VIEW = { status: 'Preparing your feedback...', turn: 0, caption: '' }

export default function LiveAvatarFeedback({ dialogue, apiUrl, onCompletionChange }) {
  const professorRef = useRef(null)
  const studentRef = useRef(null)
  const frameRef = useRef(null)
  const lifecycleRef = useRef(null)
  const [view, setView] = useState(INITIAL_VIEW)

  useEffect(() => {
    const lifecycle = mountFeedbackController({
      dialogue, apiUrl,
      videos: { Professor: professorRef.current, Student: studentRef.current },
      preserveFrame: (video) => {
        const canvas = frameRef.current
        if (!canvas || !video?.videoWidth) return
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        canvas.getContext('2d').drawImage(video, 0, 0)
        canvas.style.display = 'block'
      },
      clearFrame: () => {
        const canvas = frameRef.current
        if (!canvas) return
        canvas.style.display = 'none'
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
      },
      createSession: (token, config) => new LiveAvatarSession(token, config),
      onChange: (next) => {
        setView(next)
        onCompletionChange(next.status === 'Feedback Complete')
      },
    })
    lifecycleRef.current = lifecycle
    return () => {
      lifecycle.dispose()
      lifecycleRef.current = null
    }
  }, [dialogue, apiUrl, onCompletionChange])

  const preparing = view.status === 'Preparing your feedback...'
  const completed = view.status === 'Feedback Complete'
  const label = view.hasPlayed ? 'Replay Feedback' : view.canPrepare ? 'Retry audio preparation' : 'Play Feedback'
  const enabled = view.hasPlayed ? view.canReplay : view.canPlay || view.canPrepare
  function primaryAction() {
    if (view.hasPlayed) lifecycleRef.current?.replay()
    else if (view.canPrepare) lifecycleRef.current?.retryPreparation()
    else lifecycleRef.current?.play()
  }

  return (
    <div className="liveavatar-feedback" style={{
      border: `1.5px solid ${preparing ? '#d1fae5' : completed ? '#2ecc71' : '#e5e7eb'}`,
      background: preparing ? '#f0fdf4' : '#fff',
    }}>
      <div className="liveavatar-feedback-status" role="status">
        {preparing && <span className="liveavatar-feedback-spinner" aria-hidden="true" />}
        <span>{view.status}</span>
      </div>
      {preparing && <p className="liveavatar-feedback-note">While you wait, please review the analysis below.</p>}
      <div className="liveavatar-feedback-stage" style={{ display: view.turn || view.hasPlayed ? 'block' : 'none' }}>
        <video ref={professorRef} autoPlay playsInline aria-label="Professor" aria-hidden={view.speaker !== 'Professor'} />
        <video ref={studentRef} autoPlay playsInline aria-label="Student" aria-hidden={view.speaker !== 'Student'} />
        <canvas ref={frameRef} className="liveavatar-feedback-frame" aria-hidden="true" />
      </div>
      {view.error && <p className="liveavatar-feedback-error" role="alert">Error: {view.error}</p>}
      <div className="liveavatar-feedback-controls">
        <button className="btn-start" disabled={!enabled} onClick={primaryAction}>{label}</button>
      </div>
    </div>
  )
}
