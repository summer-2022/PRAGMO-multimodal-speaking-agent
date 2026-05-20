from dataclasses import dataclass


@dataclass(frozen=True)
class Scenario:
    key: str
    label: str
    description: str
    opening_text: str


SCENARIOS: dict[str, Scenario] = {
    "professor_extension": Scenario(
        key="professor_extension",
        label="Professor Extension Request",
        description=(
            "You need to ask your professor for a short extension for an assignment. "
            "Explain your situation and politely ask whether it is possible."
        ),
        opening_text="Hello. How can I help you today?",
    ),
}


def get_scenario(key: str) -> Scenario:
    if key not in SCENARIOS:
        raise KeyError(f"Unknown scenario key: {key!r}")
    return SCENARIOS[key]
