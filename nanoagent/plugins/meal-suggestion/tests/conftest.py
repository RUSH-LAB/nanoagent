from __future__ import annotations

from pathlib import Path

import pytest

import plugin.meals
import verifier.meals

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def recipes(monkeypatch: pytest.MonkeyPatch) -> Path:
    """The sample recipes, an excerpt of Food.com's, as the plugin's and the verifier's recipes."""
    path = FIXTURES / "recipes.json"
    monkeypatch.setattr(plugin.meals, "COOKBOOK", path)
    monkeypatch.setattr(verifier.meals, "COOKBOOK", path)
    return path
