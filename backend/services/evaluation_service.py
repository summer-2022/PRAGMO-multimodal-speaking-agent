import json
import os

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()


def evaluate_session(
    scenario_key: str,
    sp1_transcript: list,
    analysis_result: dict,
    sp2_transcript: list,
) -> dict:
    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    def fmt(transcript):
        return "\n".join(
            f"{'Student' if t['role'] == 'user' else 'Professor'}: {t['text']}"
            for t in transcript
        )

    sp1_text = fmt(sp1_transcript)
    sp2_text = fmt(sp2_transcript)

    feedback_summary = analysis_result.get("summary", "")

    # supports both old/new analysis keys
    feedback_issues_list = (
        analysis_result.get("issues")
        or analysis_result.get("areas to improve")
        or []
    )

    feedback_issues = "\n".join(
        f"- {i if isinstance(i, str) else json.dumps(i, ensure_ascii=False)}"
        for i in feedback_issues_list
    )

    feedback_focus = "\n".join(
        f"- {a}" for a in analysis_result.get("focus_areas", [])
    )

    prompt = f"""
You are an expert in L2 pragmatics assessment.

Scenario: {scenario_key}

== SP1 Transcript ==
{sp1_text}

== Feedback given to student ==
Focus areas:
{feedback_focus}

Issues identified:
{feedback_issues}

Summary:
{feedback_summary}

== SP2 Transcript ==
{sp2_text}

Evaluate the student using the SAME criteria below.

1. Pragmatics Progress
Score BOTH SP1 and SP2 from 1 to 5 for pragmatic appropriateness based on:
- Contextual Appropriateness: how well the student's language fits the situation, relationship, and social context
- Pragmatic Appropriateness: how appropriately the student expresses meaning through tone, directness, mitigation, phrasing, and politeness
- Response Appropriateness: how appropriately the student responds to the professor's turns, questions, or cues

Do NOT penalize for grammar or vocabulary.

Your explanation MUST be evidence-based.
Do NOT write generic statements such as:
- "The student used more polite language"
- "The response was more appropriate"
unless you explain exactly what changed.

You MUST compare:
- what was weak, missing, vague, too direct, or incomplete in SP1
- what was added, improved, softened, clarified, or better answered in SP2
- why that matters in a student-professor interaction

You MUST separate your explanation into three parts:
- SP1: what was weak or inappropriate
- SP2: what improved
- Analysis: why this change matters in a professor-student context

Do NOT merge them into one paragraph.

2. Feedback Uptake
Using the feedback above as reference, determine whether the student applied the suggested strategies in SP2.

Classify uptake as exactly one lowercase label:
- "yes"
- "partial"
- "no"

Then explain:
- which strategies were applied
- which strategies were still missing, if any
- what evidence from SP2 supports your judgment

3. Highlight Evidence
Select up to 2 student utterances from SP1 that best show problematic pragmatic usage.
Select up to 2 student utterances from SP2 that best show improved pragmatic usage.

Requirements:
- Return exact student utterance text from the transcript when possible
- Only choose student lines, not professor lines
- Keep lists short and precise
- If there is no clear example, return an empty list

4. Overall Summary
Provide a short overall summary of the student's pragmatic development across SP1 and SP2.
This should be specific enough that the learner understands what to repeat next time.

Return ONLY valid JSON in this exact structure:

{{
  "pragmatic_score_sp1": <integer 1-5>,
  "pragmatic_score_sp2": <integer 1-5>,

  "pragmatics_progress": {{
    "sp1": "<2-3 sentences describing weaknesses in SP1>",
    "sp2": "<2-3 sentences describing improvements in SP2>",
    "analysis": "<1-2 sentences explaining why this change matters pragmatically>"
  }},

  "feedback_uptake_label": "<yes|partial|no>",
  "feedback_uptake_reason": "<2-4 sentences. Mention applied strategies, missing strategies if any, and evidence from SP2.>",

  "problematic_lines_sp1": ["<exact student utterance>", "<exact student utterance>"],
  "improved_lines_sp2": ["<exact student utterance>", "<exact student utterance>"],

  "evaluation_summary": "<2-4 sentences. Specific, learner-facing, and actionable.>"
}}
"""

    response = client.chat.completions.create(
        model="gpt-4.1",
        messages=[
            {
                "role": "system",
                "content": "You are an expert L2 pragmatics evaluator. Always return valid JSON only.",
            },
            {"role": "user", "content": prompt},
        ],
        temperature=0.2,
    )

    text_output = response.choices[0].message.content

    try:
        return json.loads(text_output)
    except json.JSONDecodeError:
        raise ValueError(f"Failed to parse evaluation response: {text_output}")



# import json
# import os

# from dotenv import load_dotenv
# from openai import OpenAI

# load_dotenv()


# def evaluate_session(
#     scenario_key: str,
#     sp1_transcript: list,
#     analysis_result: dict,
#     sp2_transcript: list,
# ) -> dict:
#     client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

#     def fmt(transcript):
#         return "\n".join(
#             f"{'Student' if t['role'] == 'user' else 'Professor'}: {t['text']}"
#             for t in transcript
#         )

#     sp1_text = fmt(sp1_transcript)
#     sp2_text = fmt(sp2_transcript)
#     feedback_summary = analysis_result.get("summary", "")
#     feedback_issues = "\n".join(f"- {i}" for i in analysis_result.get("issues", []))
#     feedback_focus = "\n".join(f"- {a}" for a in analysis_result.get("focus_areas", []))

#     prompt = f"""
# You are an expert in L2 pragmatics assessment.

# Scenario: {scenario_key}

# == SP1 Transcript ==
# {sp1_text}

# == Feedback given to student ==
# Focus areas:
# {feedback_focus}

# Issues identified:
# {feedback_issues}

# Summary:
# {feedback_summary}

# == SP2 Transcript ==
# {sp2_text}

# Evaluate the student using the criteria below.

# 1. Pragmatics Progress
#    Score BOTH SP1 and SP2 (1–5) for pragmatic appropriateness based on the three criteria below: 
#         - Contextual Appropriateness: how well the student’s language fits the situation, relationship, and social context
#         - Pragmatic Appropriateness: how appropriately the student expresses meaning through language use (e.g., tone, level of directness, and phrasing)
#         - Response Appropriateness: how appropriately the student responds to the interlocutor’s turns, questions, or cues
   
#    Do NOT penalise for grammar or vocabulary.
#    Then explain briefly how SP2 changed compared with SP1.

# 2. Feedback Uptake
#    Using the feedback above as reference, determine whether the student applied the suggested strategies in SP2.
#    Classify uptake as exactly one of the following lowercase labels:
#    - "yes"
#    - "partial"
#    - "no"
#    Use lowercase values only.
#    These labels will be displayed in the UI as:
#    - Yes Uptake
#    - Partial Uptake
#    - No Uptake
#    Then explain briefly why.

# 3. Highlight Evidence
#    Select up to 2 student utterances from SP1 that best show problematic pragmatic usage.
#    Select up to 2 student utterances from SP2 that best show improved pragmatic usage.
#    Requirements:
#    - Return exact utterance text from the transcript when possible
#    - Only choose student lines, not professor lines
#    - Keep lists short and precise
#    - If there is no clear example, return an empty list

# 4. Overall Summary
#    Provide a short overall summary of the student's pragmatic development across SP1 and SP2.

# Return ONLY valid JSON in this exact structure (no markdown, no extra text):

# {{
#   "pragmatic_score_sp1": <integer 1-5>,
#   "pragmatic_score_sp2": <integer 1-5>,
#   "pragmatics_progress": "<one or two sentences describing change from SP1 to SP2>",
#   "feedback_uptake_label": "<yes|partial|no>",
#   "feedback_uptake_reason": "<one or two sentences>",
#   "problematic_lines_sp1": ["<exact student utterance>", "<exact student utterance>"],
#   "improved_lines_sp2": ["<exact student utterance>", "<exact student utterance>"],
#   "evaluation_summary": "<two or three sentences overall summary>"
# }}
# """

#     response = client.chat.completions.create(
#         model="gpt-4.1",
#         messages=[
#             {"role": "system", "content": "You are an expert L2 pragmatics evaluator."},
#             {"role": "user", "content": prompt},
#         ],
#         temperature=0.2,
#     )

#     return json.loads(response.choices[0].message.content)



# import json
# import os

# from dotenv import load_dotenv
# from openai import OpenAI

# load_dotenv()


# def evaluate_session(
#     scenario_key: str,
#     sp1_transcript: list,
#     analysis_result: dict,
#     sp2_transcript: list,
# ) -> dict:
#     client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

#     def fmt(transcript):
#         return "\n".join(
#             f"{'Student' if t['role'] == 'user' else 'Professor'}: {t['text']}"
#             for t in transcript
#         )

#     sp1_text = fmt(sp1_transcript)
#     sp2_text = fmt(sp2_transcript)
#     feedback_summary = analysis_result.get("summary", "")
#     feedback_issues = "\n".join(f"- {i}" for i in analysis_result.get("issues", []))
#     feedback_focus = "\n".join(f"- {a}" for a in analysis_result.get("focus_areas", []))

#     prompt = f"""
# You are an expert in L2 pragmatics assessment.

# Scenario: {scenario_key}

# == SP1 Transcript ==
# {sp1_text}

# == Feedback given to student ==
# Focus areas:
# {feedback_focus}

# Issues identified:
# {feedback_issues}

# Summary:
# {feedback_summary}

# == SP2 Transcript ==
# {sp2_text}

# Evaluate the student using the three criteria below.

# 1. Pragmatics Progress
#    Score BOTH SP1 and SP2 (1–5) for pragmatic appropriateness in this scenario.
#    Focus on: politeness, mitigation, clarity of request, respectful tone.
#    Do NOT penalise for grammar or vocabulary.
#    Then explain briefly how SP2 changed compared with SP1.

# 2. Feedback Uptake
#    Using the feedback above as reference, determine whether the student applied the suggested strategies in SP2.
#    Classify uptake as one of:
#    - "yes"
#    - "partial"
#    - "no"
#    Then explain briefly why.

# 3. Overall Summary
#    Provide a short overall summary of the student's pragmatic development across SP1 and SP2.

# Return ONLY valid JSON in this exact structure (no markdown, no extra text):

# {{
#   "pragmatic_score_sp1": <integer 1-5>,
#   "pragmatic_score_sp2": <integer 1-5>,
#   "pragmatics_progress": "<one or two sentences describing change from SP1 to SP2>",
#   "feedback_uptake_label": "<yes|partial|no>",
#   "feedback_uptake_reason": "<one or two sentences>",
#   "evaluation_summary": "<two or three sentences overall summary>"
# }}
# """

#     response = client.chat.completions.create(
#         model="gpt-4.1",
#         messages=[
#             {"role": "system", "content": "You are an expert L2 pragmatics evaluator."},
#             {"role": "user", "content": prompt},
#         ],
#         temperature=0.2,
#     )

#     return json.loads(response.choices[0].message.content)





# import json
# import os

# from dotenv import load_dotenv
# from openai import OpenAI

# load_dotenv()


# def evaluate_session(
#     scenario_key: str,
#     sp1_transcript: list,
#     analysis_result: dict,
#     sp2_transcript: list,
# ) -> dict:
#     client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

#     def fmt(transcript):
#         return "\n".join(
#             f"{'Student' if t['role'] == 'user' else 'Professor'}: {t['text']}"
#             for t in transcript
#         )

#     sp1_text = fmt(sp1_transcript)
#     sp2_text = fmt(sp2_transcript)
#     feedback_summary = analysis_result.get("summary", "")
#     feedback_issues = "\n".join(f"- {i}" for i in analysis_result.get("issues", []))
#     feedback_focus = "\n".join(f"- {a}" for a in analysis_result.get("focus_areas", []))

#     prompt = f"""
# You are an expert in L2 pragmatics assessment.

# Scenario: {scenario_key}

# == SP1 Transcript ==
# {sp1_text}

# == Feedback given to student ==
# Focus areas:
# {feedback_focus}

# Issues identified:
# {feedback_issues}

# Summary:
# {feedback_summary}

# == SP2 Transcript ==
# {sp2_text}

# Evaluate the student using the three criteria below.

# 1. Pragmatic Score (SP2)
#    Score SP2 alone (1–5) for pragmatic appropriateness in this scenario.
#    Focus on: politeness, mitigation, clarity of request, respectful tone.
#    Do NOT penalise for grammar or vocabulary.

# 2. SP1 vs SP2 Improvement
#    Compare overall pragmatic performance between SP1 and SP2.
#    Do NOT compare exact wording — evaluate whether SP2 shows better pragmatic performance.
#    Be specific about what changed or did not change.

# 3. Feedback Uptake
#    Using the feedback above as reference, evaluate whether the strategies suggested
#    in the feedback appear in SP2.
#    Do NOT require sentence copying — focus on strategy uptake.

# Return ONLY valid JSON in this exact structure (no markdown, no extra text):

# {{
#   "pragmatic_score_sp2": <integer 1-5>,
#   "pragmatic_reason_sp2": "<one or two sentences>",
#   "improvement_sp1_vs_sp2": "<one or two sentences>",
#   "feedback_uptake": "<one or two sentences>",
#   "evaluation_summary": "<two or three sentences overall summary>"
# }}
# """

#     response = client.chat.completions.create(
#         model="gpt-4.1",
#         messages=[
#             {"role": "system", "content": "You are an expert L2 pragmatics evaluator."},
#             {"role": "user", "content": prompt},
#         ],
#         temperature=0.2,
#     )

#     return json.loads(response.choices[0].message.content)
