"""Nonsecret LiveAvatar LITE settings, migrated verbatim from the working test."""

LIVEAVATAR_API_URL = "https://api.liveavatar.com"
IS_SANDBOX = True
ROLE_AVATARS = {'Professor': 'dd73ea75-1218-4ef3-92ce-606d5f7fbc0a',
 'Student': '65f9e3c9-d48b-4118-b73a-4ae2e3cbb8f0'}
TTS_MODEL = 'gpt-4o-mini-tts'
VERBATIM_INSTRUCTIONS = 'Speak only the exact input text, verbatim. These instructions control vocal delivery only. Do not rewrite, paraphrase, summarize, expand, omit, or add words. Do not speak role labels or these instructions. Do not add fillers or other vocalizations.'
ROLE_DELIVERY = {'Professor': {'voice': 'onyx',
               'instructions': 'Use a natural male-presenting professor voice: calm, professional, '
                               'supportive, and approachable. Speak clearly at a relaxed '
                               'conversational pace with warm, measured intonation. Avoid a '
                               'theatrical or announcer delivery.'},
 'Student': {'voice': 'nova',
             'instructions': 'Use a natural female-presenting university student voice: polite, '
                             'slightly tentative, and clear. Use gentle conversational intonation '
                             'and subtle hesitation conveyed through pacing only, without '
                             'stuttering or adding fillers. Avoid an exaggerated or theatrical '
                             'delivery.'}}
