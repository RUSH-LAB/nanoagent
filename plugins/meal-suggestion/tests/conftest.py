from __future__ import annotations

import shutil
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"
INGREDIENTS = "inputs/ingredients.json"
RECIPES = "inputs/recipes.json"


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    """A workspace with the sample ingredients and recipes staged as NanoAgent stages `inputs:`."""
    (tmp_path / "inputs").mkdir()
    for name in ("ingredients.json", "recipes.json"):
        shutil.copyfile(FIXTURES / name, tmp_path / "inputs" / name)
    return tmp_path
