import os
import time
import requests
from dotenv import load_dotenv

load_dotenv()

HEYGEN_API_KEY = os.getenv("HEYGEN_API_KEY")

AVATAR_A = "Aditya_public_4"
AVATAR_B = "Abigail_expressive_2024112501"

VOICE_A = "828b59f834fd4c7188da322b6d9b6c75"
VOICE_B = "cef3bc4e0a84424cafcde6f2cf466c97"


def build_video_script(video_dialogue):
    video_inputs = []

    for line in video_dialogue:
        speaker = line["speaker"].strip().lower()
        text = line["text"]

        if speaker in ["professor", "teacher", "advisor", "a"]:
            avatar_id = AVATAR_A
            voice_id = VOICE_A
        else:
            avatar_id = AVATAR_B
            voice_id = VOICE_B

        video_inputs.append({
            "character": {
                "type": "avatar",
                "avatar_id": avatar_id,
            },
            "voice": {
                "type": "text",
                "voice_id": voice_id,
                "input_text": text,
            },
        })

    return video_inputs


def generate_video(video_script):
    url = "https://api.heygen.com/v2/video/generate"
    headers = {
        "X-Api-Key": HEYGEN_API_KEY,
        "Content-Type": "application/json",
    }
    payload = {
        "video_inputs": video_script,
        "dimension": {"width": 1280, "height": 720},
        "background": {
            "type": "image",
            "url": "https://images.unsplash.com/photo-1562774053-701939374585?w=1920&h=1080&fit=crop",
        },
    }

    response = requests.post(url, headers=headers, json=payload, timeout=60)
    response.raise_for_status()
    return response.json()["data"]["video_id"]


def poll_video(video_id, max_wait_seconds=1200, interval_seconds=10):
    url = "https://api.heygen.com/v1/video_status.get"
    headers = {"X-Api-Key": HEYGEN_API_KEY}
    start = time.time()

    while time.time() - start < max_wait_seconds:
        response = requests.get(
            url,
            headers=headers,
            params={"video_id": video_id},
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()["data"]
        status = data["status"]

        print(f"[heygen] status={status}")

        if status == "completed":
            return data["video_url"]
        if status == "failed":
            raise RuntimeError(f"HeyGen video generation failed: {data}")

        time.sleep(interval_seconds)

    raise TimeoutError("Timed out waiting for HeyGen video generation.")


def generate_feedback_video(video_dialogue):
    if not HEYGEN_API_KEY:
        raise ValueError("HEYGEN_API_KEY is not set.")

    video_script = build_video_script(video_dialogue)
    video_id = generate_video(video_script)
    print(f"[heygen] video_id={video_id}")
    video_url = poll_video(video_id)

    return {
        "video_url": video_url,
        "video_script": video_script,
    }
