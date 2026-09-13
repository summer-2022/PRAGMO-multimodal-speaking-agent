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
- Contextual Appropriateness: whether the student's language fits the situation, relationship, and social context
- Pragmatic Appropriateness: whether the student expresses the intended meaning with appropriate tone, directness, mitigation, politeness, and phrasing
- Response Appropriateness: whether the student responds appropriately and relevantly to the professor's turns, questions, and cues
- Task Fulfillment (supporting criterion): whether the student clearly communicates the intended purpose and provides enough relevant information for the professor to respond appropriately

Pragmatic appropriateness is the primary basis of each overall score.
Task Fulfillment is supporting evidence of communicative effectiveness, not an equal or dominant scoring category.
Task completion alone does not make a response pragmatically appropriate.
Polite language alone does not demonstrate successful pragmatic performance when the communicative purpose is substantially unclear or incomplete.
Return only one overall pragmatic score for SP1 and one for SP2; do not add dimension scores.

Use this exact 1–5 scoring interpretation for both SP1 and SP2:
5 = Fully pragmatically appropriate and communicatively effective. The student’s language fits the situation and relationship, uses suitable pragmatic strategies, responds appropriately to the professor, and communicates the intended purpose clearly. No meaningful pragmatic problem.
4 = Generally pragmatically appropriate and effective. There may be a minor omission or awkward choice, but it does not meaningfully interfere with the interaction.
3 = Partially appropriate. The student’s main intention is understandable, but a noticeable problem in contextual fit, pragmatic expression, responsiveness, or essential task information reduces effectiveness.
2 = Mostly inappropriate or ineffective. Multiple important pragmatic problems or omissions make the interaction socially awkward or make an appropriate response difficult.
1 = Seriously inappropriate or ineffective. The student largely fails to address the communicative purpose or substantially violates the situation, relationship, or conversational context.

Score SP1 and SP2 independently using the same criteria and scale.
Do not assume SP2 is better simply because it occurred after feedback; it may receive the same or a lower score when supported by the evidence.
Justify every score difference with specific evidence from both transcripts.
Distinguish improvement in pragmatic appropriateness from the simple addition of more content.

Do NOT penalize for grammar or vocabulary.

Your explanation MUST be evidence-based.
Do NOT write generic statements such as:
- "The student used more polite language"
- "The response was more appropriate"
unless you explain exactly what changed.

You MUST compare:
- what was appropriate or weak, missing, vague, too direct, or incomplete in SP1
- what improved, remained unchanged, or became less appropriate in SP2
- why that matters in a student-professor interaction

You MUST separate your explanation into three parts:
- SP1: evidence supporting its independent score
- SP2: evidence supporting its independent score, including improvement, no change, or decline
- Analysis: why the observed change or lack of change matters in a professor-student context

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
Give one actionable takeaway for future interactions.

Output length and readability:
- pragmatics_progress.sp1: maximum 2 concise sentences about the most important weakness in SP1; if none is supported, state that without inventing a weakness.
- pragmatics_progress.sp2: maximum 2 concise sentences about the most important improvement or remaining weakness in SP2, accurately reflecting no change or decline when applicable.
- pragmatics_progress.analysis: exactly 1 concise sentence explaining why the change or lack of change matters pragmatically.
- feedback_uptake_reason: maximum 2 concise sentences identifying which feedback strategy was or was not applied.
- evaluation_summary: maximum 2 concise sentences giving one actionable takeaway for future interactions.
- Use learner-friendly, direct language and only the evidence necessary to justify each judgment.
- Each section must serve its distinct purpose; do not repeat the same evidence or explanation across multiple sections.
- Use at most one short exact transcript quotation in each SP1 or SP2 explanation when needed. Do not include long transcript quotations.

Return ONLY valid JSON in this exact structure:

{{
  "pragmatic_score_sp1": <integer 1-5>,
  "pragmatic_score_sp2": <integer 1-5>,

  "pragmatics_progress": {{
    "sp1": "<maximum 2 concise sentences on the most important SP1 weakness, with necessary score evidence>",
    "sp2": "<maximum 2 concise sentences on the most important SP2 improvement or remaining weakness, with necessary score evidence>",
    "analysis": "<exactly 1 concise sentence explaining why the change or lack of change matters pragmatically>"
  }},

  "feedback_uptake_label": "<yes|partial|no>",
  "feedback_uptake_reason": "<maximum 2 concise sentences identifying which feedback strategy was or was not applied, with necessary evidence>",

  "problematic_lines_sp1": ["<exact student utterance>", "<exact student utterance>"],
  "improved_lines_sp2": ["<exact student utterance>", "<exact student utterance>"],

  "evaluation_summary": "<maximum 2 concise sentences giving one actionable takeaway for future interactions>"
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
