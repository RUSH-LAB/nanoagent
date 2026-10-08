from __future__ import annotations

import shutil
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"
RECIPES = "inputs/recipes.json"


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    """A workspace with the sample recipes, an excerpt of Food.com's, staged as NanoAgent stages `inputs:`."""
    (tmp_path / "inputs").mkdir()
    shutil.copyfile(FIXTURES / "recipes.json", tmp_path / RECIPES)
    return tmp_path
