"""Issue role-specific LITE tokens; never return partial token pairs."""
import os

import requests

from config.liveavatar_feedback import IS_SANDBOX, LIVEAVATAR_API_URL, ROLE_AVATARS


def issue_session_token(avatar_id: str) -> str:
    api_key = os.getenv("LIVEAVATAR_API_KEY")
    if not api_key:
        raise RuntimeError("LiveAvatar is not configured")
    try:
        response = requests.post(
            f"{LIVEAVATAR_API_URL}/v1/sessions/token",
            headers={"X-API-KEY": api_key, "Content-Type": "application/json"},
            json={"mode": "LITE", "avatar_id": avatar_id, "is_sandbox": IS_SANDBOX},
            timeout=30,
        )
        if not response.ok:
            raise ValueError("Provider rejected request")
        token = response.json()["data"]["session_token"]
        if not isinstance(token, str) or not token.strip():
            raise ValueError("Invalid token")
        return token
    except Exception:
        raise RuntimeError("LiveAvatar token request failed") from None


def create_dialogue_tokens() -> dict:
    roles = ("Professor", "Student")
    avatar_ids = [ROLE_AVATARS.get(role) for role in roles]
    if any(not isinstance(value, str) or not value.strip() for value in avatar_ids):
        raise RuntimeError("Both LiveAvatar roles must be configured")
    if len(set(avatar_ids)) != 2:
        raise RuntimeError("LiveAvatar roles require distinct avatars")
    # Build the full pair before returning anything to the HTTP layer.
    return {role: issue_session_token(ROLE_AVATARS[role]) for role in roles}
