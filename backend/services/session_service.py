import json
from datetime import datetime
from pathlib import Path


def save_session_result(
    scenario_key: str,
    scenario_label: str,
    sp1_transcript: list,
    analysis_result: dict,
    video_script: list | None,
    video_url: str,
    sp2_transcript: list,
    evaluation_result: dict | None = None,
    results_dir: str = "results",
) -> str:
    Path(results_dir).mkdir(exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    save_path = Path(results_dir) / f"session_{timestamp}.json"

    result = {
        "scenario_key": scenario_key,
        "scenario_label": scenario_label,
        "sp1_transcript": sp1_transcript,
        "analysis": analysis_result,
        "video_script": video_script,
        "video_url": video_url,
        "sp2_transcript": sp2_transcript,
        "evaluation": evaluation_result,
    }

    with open(save_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    return str(save_path)
