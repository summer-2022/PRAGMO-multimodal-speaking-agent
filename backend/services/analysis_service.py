import json
import os
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()


def analyze_transcript(transcript: list) -> dict:
    dialogue_lines = []
    for turn in transcript:
        speaker = "Student" if turn["role"] == "user" else "Professor"
        dialogue_lines.append(f"{speaker}: {turn['text']}")
    dialogue = "\n".join(dialogue_lines)

    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    prompt = f"""
You are an expert in L2 pragmatics assessment.

Analyze the following dialogue between a student and a professor.

Focus on pragmatic appropriateness, especially:
- Contextual Appropriateness: whether the student's language fits the professor-student relationship
- Pragmatic Appropriateness: tone, directness, mitigation, politeness, phrasing
- Response Appropriateness: whether the student responds appropriately to the professor's questions or cues

Do NOT focus mainly on grammar or vocabulary.
Do NOT focus on greetings or closings unless they are the only issue.

Your feedback must be concrete and evidence-based.
For each issue:
- identify the pragmatic problem
- include an exact student utterance from the dialogue when possible
- explain why it is a problem in this context
- give a practical fix the student can reuse

Then create a short reenacted dialogue that demonstrates a better interaction.

IMPORTANT:
The video dialogue should be a CONTINUOUS 4-turn interaction.

Structure:
Professor
Student
Professor
Student

Requirements:
- exactly 4 turns
- short sentences, max 10–12 words each
- natural conversational language
- focus on improving the key pragmatic issue
- do NOT summarize — reenact the interaction

Return ONLY valid JSON in this exact structure:

{{
  "focus_areas": ["<short focus area>", "<short focus area>"],
  "issues": [
    {{
      "type": "<short issue type>",
      "description": "<1-2 sentences explaining the pragmatic issue>",
      "example": "<exact student utterance from the dialogue>",
      "fix": "<specific strategy the student should use next time>"
    }}
  ],
  "summary": "<2-3 sentences explaining the main pragmatic weakness in learner-friendly language>",
  "video_dialogue": [
    {{
      "speaker": "Professor",
      "text": ""
    }},
    {{
      "speaker": "Student",
      "text": ""
    }},
    {{
      "speaker": "Professor",
      "text": ""
    }},
    {{
      "speaker": "Student",
      "text": ""
    }}
  ]
}}

Dialogue:
{dialogue}
"""

    response = client.chat.completions.create(
        model="gpt-4.1",
        messages=[
            {
                "role": "system",
                "content": "You are an expert L2 speaking instructor. Always return valid JSON only.",
            },
            {"role": "user", "content": prompt},
        ],
        temperature=0.3,
    )

    text_output = response.choices[0].message.content

    try:
        return json.loads(text_output)
    except json.JSONDecodeError:
        raise ValueError(f"Failed to parse analysis response: {text_output}")



# import json
# import os
# from dotenv import load_dotenv
# from openai import OpenAI

# load_dotenv()


# def analyze_transcript(transcript: list) -> dict:
#     dialogue_lines = []
#     for turn in transcript:
#         speaker = "Student" if turn["role"] == "user" else "Professor"
#         dialogue_lines.append(f"{speaker}: {turn['text']}")
#     dialogue = "\n".join(dialogue_lines)

#     client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

#     prompt = f"""
#       You are an expert in L2 pragmatics assessment.

#       Analyze the following dialogue between a student and a professor.

#       1. Prioritize issues related to how appropriately the student adapts their language to the situation and relationship, and how they respond to the other person.
#             In particular, consider: 
#             - Situation & Relationship: whether the language fits the social context 
#             - Language use: how appropriately the student expresses meaning (e.g., tone, level of directness, and phrasing) 
#             - Response Appropriateness: how appropriately the student responds to the interlocutor’s questions or cues.
#       2. Locate the moment in the dialogue where this issue appears.
#       3. Create a short reenacted dialogue that demonstrates a better interaction.

#       Focus especially on how the student responds to the interlocuter's questions
#       and how the interaction develops after the initial request.

#       Evaluate the student's pragmatic language in context
     
#       Do NOT focus on greeting or closing expressions unless they are the only issue.
#       Prefer issues that occur in the middle of the interaction rather than the final closing.

#       Focus only on the most relevant category or categories for this interaction.

#       Analysis output guidelines:
#       - Each issue should be 1–2 sentences long.
#       - For each issue, briefly explain the pragmatic problem and include a concrete example from the dialogue.
#       - The summary should be 2–3 sentences long and explain the main pragmatic weakness in a way the learner can easily understand.
#       - Avoid repetition across issues, but provide enough detail to make the feedback worth reading.
#       - Keep the feedback clear and focused, not overly long or academic.

#       IMPORTANT:
#       The video dialogue should be a CONTINUOUS 4-turn interaction.

#       Structure:

#       Professor
#       Student
#       Professor
#       Student

#       Requirements:
#       - exactly 4 turns
#       - short sentences (max 10–12 words)
#       - natural conversational language
#       - focus on improving the key pragmatic issue
#       - the dialogue should resemble a realistic continuation of the conversation
#       - do NOT summarize — reenact the interaction

#       Return the result in this JSON format:

#       {{
#         "focus_areas": [],
#         "areas to improve": [],
#         "summary": "",
#         "video_dialogue": [
#           {{
#             "speaker": "Professor",
#             "text": ""
#           }},
#           {{
#             "speaker": "Student",
#             "text": ""
#           }},
#           {{
#             "speaker": "Professor",
#             "text": ""
#           }},
#           {{
#             "speaker": "Student",
#             "text": ""
#           }}
#         ]
#       }}

#       Dialogue:
#       {dialogue}
#       """

#     response = client.chat.completions.create(
#         model="gpt-4.1",
#         messages=[
#             {"role": "system", "content": "You are an expert L2 speaking instructor."},
#             {"role": "user", "content": prompt}
#         ],
#         temperature=0.3
#     )

#     text_output = response.choices[0].message.content

#     try:
#         return json.loads(text_output)
#     except json.JSONDecodeError:
#         raise ValueError(f"Failed to parse analysis response: {text_output}")
