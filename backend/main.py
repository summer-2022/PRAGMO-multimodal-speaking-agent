import asyncio
import base64
import json
import os

from dotenv import load_dotenv

import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from config.scenarios import get_scenario
from services.analysis_service import analyze_transcript
from services.evaluation_service import evaluate_session
from services.session_service import save_session_result
from services.video_service import generate_feedback_video

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]
OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"

# 100 ms of PCM16 at 24 kHz mono = 24000 samples/s * 2 bytes * 0.1 s = 4800 bytes
PCM_CHUNK_BYTES = 4800


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("[ws] client connected")

    # Spawn ffmpeg: read streaming webm/opus from stdin, write raw PCM16 24kHz mono to stdout
    ffmpeg_proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-f", "webm",          # container hint (MediaRecorder output)
        "-i", "pipe:0",        # read from stdin
        "-f", "s16le",         # output: raw signed 16-bit little-endian
        "-ar", "24000",        # sample rate: 24 kHz
        "-ac", "1",            # mono
        "pipe:1",              # write to stdout
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )

    openai_headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "OpenAI-Beta": "realtime=v1",
    }

    _scenario = get_scenario("professor_extension")
    session = {
        "phase": "sp1",
        "scenario_key": _scenario.key,
        "scenario_label": _scenario.label,
        "sp1_transcript": [],
        "sp2_transcript": [],
        "analysis": None,
        "video_script": None,
        "video_url": "",
        "evaluation": None,
    }

    try:
        async with websockets.connect(
            OPENAI_REALTIME_URL,
            additional_headers=openai_headers,
        ) as openai_ws:

            await openai_ws.send(json.dumps({
                "type": "session.update",
                "session": {
                    "modalities": ["text", "audio"],
                    "input_audio_format": "pcm16",
                    "output_audio_format": "pcm16",
                    "voice": "verse",
                    "instructions": "You are a university professor in the U.S. Start the conversation with a short greeting. Speak naturally and keep responses to 1–2 short sentences.",
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.5,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 500,
                    },
                    "input_audio_transcription": {
                        "model": "whisper-1",
                    },
                },
            }))

            async def pipe_frontend_to_ffmpeg():
                """Receive binary audio chunks from the browser and feed them into ffmpeg.
                Also handles text control messages (e.g. finish_sp1)."""
                try:
                    while True:
                        message = await websocket.receive()
                        if message.get("bytes"):
                            ffmpeg_proc.stdin.write(message["bytes"])
                            await ffmpeg_proc.stdin.drain()
                        elif message.get("text"):
                            data = json.loads(message["text"])
                            if data.get("type") == "set_scenario":
                                key = data.get("scenario", "")
                                try:
                                    scenario = get_scenario(key)
                                    session["scenario_key"] = scenario.key
                                    session["scenario_label"] = scenario.label
                                    print(f"[ws] scenario set to '{scenario.key}'")
                                except Exception as e:
                                    print(f"[ws] set_scenario error (key={key!r}): {e}")
                            elif data.get("type") == "finish_sp1":
                                print("[ws] finish_sp1 received — running analysis")
                                analysis = await asyncio.to_thread(
                                    analyze_transcript, session["sp1_transcript"]
                                )
                                session["analysis"] = analysis
                                session["video_script"] = analysis.get("video_dialogue")
                                await websocket.send_text(json.dumps({
                                    "type": "analysis_result",
                                    "data": analysis,
                                }))
                            elif data.get("type") == "start_sp2":
                                print("[ws] start_sp2 received — switching to SP2 phase")
                                session["phase"] = "sp2"
                                session["sp2_transcript"] = []
                                session["evaluation"] = None
                                session["sp1_transcript"] = data.get("sp1_transcript", [])
                                session["analysis"] = data.get("analysis")


                            elif data.get("type") == "finish_sp2":
                                print("[ws] finish_sp2 received — running evaluation")
                                
                                # DEBUG
                                print("sp1 =", session.get("sp1_transcript"))
                                print("analysis =", session.get("analysis"))
                                print("sp2 =", session.get("sp2_transcript"))
                                print("sp1 len =", len(session.get("sp1_transcript") or []))
                                print("sp2 len =", len(session.get("sp2_transcript") or []))
                                print("analysis exists =", session.get("analysis") is not None)
                                
                                
                                
                                
                                sp1 = session.get("sp1_transcript")
                                analysis = session.get("analysis")
                                sp2 = session.get("sp2_transcript")
                                if not sp1 or not analysis or not sp2:
                                    print("[ws] finish_sp2: missing data, skipping evaluation")
                                else:
                                    try:
                                        evaluation = await asyncio.to_thread(
                                            evaluate_session,
                                            session.get("scenario_key", "professor_extension"),
                                            sp1,
                                            analysis,
                                            sp2,
                                        )
                                        session["evaluation"] = evaluation
                                        save_path = await asyncio.to_thread(
                                            save_session_result,
                                            session.get("scenario_key", "professor_extension"),
                                            session.get("scenario_label", "Professor Extension Request"),
                                            sp1,
                                            analysis,
                                            session.get("video_script"),
                                            session.get("video_url", ""),
                                            sp2,
                                            evaluation,
                                        )
                                        print(f"[ws] session saved to {save_path}")
                                        await websocket.send_text(json.dumps({
                                            "type": "evaluation_result",
                                            "data": evaluation,
                                        }))
                                    # except Exception as e:
                                    #     print(f"[ws] finish_sp2 error: {e}")
                                    except Exception as e: #debugging: catch all to prevent websocket from crashing
                                        import traceback
                                        print("[ws] finish_sp2 error:", repr(e))
                                        traceback.print_exc()


                except (WebSocketDisconnect, Exception):
                    pass
                finally:
                    # Signal EOF so ffmpeg flushes and closes its stdout
                    ffmpeg_proc.stdin.close()

            async def pipe_ffmpeg_to_openai():
                """Read PCM16 chunks from ffmpeg stdout and stream them to OpenAI."""
                while True:
                    pcm = await ffmpeg_proc.stdout.read(PCM_CHUNK_BYTES)
                    if not pcm:
                        break
                    audio_b64 = base64.b64encode(pcm).decode("utf-8")
                    await openai_ws.send(json.dumps({
                        "type": "input_audio_buffer.append",
                        "audio": audio_b64,
                    }))

            async def forward_openai_to_frontend():
                """Listen to OpenAI events and relay relevant ones to the frontend."""
                async for raw in openai_ws:
                    event = json.loads(raw)
                    event_type = event.get("type", "")

                    if event_type == "input_speech_started":
                        await websocket.send_text(json.dumps({"type": "user_speaking"}))

                    elif event_type == "input_speech_stopped":
                        await websocket.send_text(json.dumps({"type": "ai_speaking"}))

                    elif event_type == "conversation.item.input_audio_transcription.completed":
                        text = event.get("transcript", "").strip()
                        if text:
                            # Forward to frontend (unchanged)
                            await websocket.send_text(json.dumps({
                                "role": "user",
                                "text": text,
                            }))
                            # Store in session
                            entry = {"role": "user", "text": text}
                            if session["phase"] == "sp1":
                                session["sp1_transcript"].append(entry)
                            elif session["phase"] == "sp2":
                                session["sp2_transcript"].append(entry)

                    elif event_type == "response.audio_transcript.done":
                        text = event.get("transcript", "").strip()
                        if text:
                            # Forward to frontend (unchanged)
                            await websocket.send_text(json.dumps({
                                "role": "assistant",
                                "text": text,
                            }))
                            # Store in session
                            entry = {"role": "assistant", "text": text}
                            if session["phase"] == "sp1":
                                session["sp1_transcript"].append(entry)
                            elif session["phase"] == "sp2":
                                session["sp2_transcript"].append(entry)

                    elif event_type == "response.audio.delta":
                        audio_b64 = event.get("delta", "")
                        if audio_b64:
                            print(f"[audio.delta] forwarding {len(audio_b64)} base64 chars to frontend")
                            await websocket.send_text(json.dumps({
                                "type": "audio.delta",
                                "audio": audio_b64,
                            }))

                    elif event_type == "response.audio.done":
                        print("[audio.done] audio response complete")
                        await websocket.send_text(json.dumps({"type": "audio.done"}))

                    elif event_type == "error":
                        print(f"[openai error] {event}")

            await asyncio.gather(
                pipe_frontend_to_ffmpeg(),
                pipe_ffmpeg_to_openai(),
                forward_openai_to_frontend(),
            )

    except WebSocketDisconnect:
        print("[ws] client disconnected")
    except Exception as e:
        print(f"[error] {e}")
    finally:
        if ffmpeg_proc.returncode is None:
            ffmpeg_proc.terminate()
            await ffmpeg_proc.wait()
        print("[ws] session ended")


class VideoRequest(BaseModel):
    video_dialogue: list


@app.post("/generate-video")
async def generate_video_endpoint(request: VideoRequest):
    result = await asyncio.to_thread(generate_feedback_video, request.video_dialogue)
    return {"video_url": result["video_url"]}
