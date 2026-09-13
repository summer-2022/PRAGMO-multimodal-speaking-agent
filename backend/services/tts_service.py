"""Role-specific OpenAI speech: exact input -> raw 24 kHz mono PCM16 bytes."""
import os

from config.liveavatar_feedback import ROLE_DELIVERY, TTS_MODEL, VERBATIM_INSTRUCTIONS


def synthesize_speech(text: str, speaker: str) -> bytes:
    if speaker not in ROLE_DELIVERY:
        raise ValueError("Unsupported speaker")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Text must not be empty")
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OpenAI TTS is not configured")
    role = ROLE_DELIVERY[speaker]
    try:
        # Lazy client construction avoids additional import-time credential
        # requirements and keeps the provider client entirely server-side.
        from openai import OpenAI

        with OpenAI(api_key=api_key) as client:
            response = client.audio.speech.create(
                model=TTS_MODEL,
                voice=role["voice"],
                instructions=VERBATIM_INSTRUCTIONS + " " + role["instructions"],
                input=text,
                response_format="pcm",
            )
            pcm = response.content
        if not isinstance(pcm, bytes) or not pcm or len(pcm) % 2:
            raise ValueError("Invalid PCM response")
        return pcm
    except Exception:
        raise RuntimeError("TTS generation failed") from None
