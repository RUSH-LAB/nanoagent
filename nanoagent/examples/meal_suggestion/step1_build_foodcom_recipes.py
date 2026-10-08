"""The meal-suggestion plugin's recipes file, built from Food.com's recipes (Kaggle, CC0)."""

import hashlib
import html
import math
import re
import tempfile
import urllib.request
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated

import pyarrow.parquet as pq
from omegaconf import MISSING
from slimconfig import Config, Layout, Output, Run

from nanoagent.plugin.contract import contract_module

PLUGIN = Path(__file__).resolve().parents[2] / "plugins" / "meal-suggestion"
with contract_module(PLUGIN) as contract:
    Cookbook, CookbookRecipe, Meal, Nutrition = contract.Cookbook, contract.CookbookRecipe, contract.Meal, contract.Nutrition

# The file in the Kaggle download, and each Nutrition field's Food.com column.
PARQUET = "recipes.parquet"
CREDIT = "Food.com recipes (Kaggle irkaal/foodcom-recipes-and-reviews, version 2, CC0)"
COLUMNS = {
    "kcal": "Calories",
    "protein": "ProteinContent",
    "fat": "FatContent",
    "saturated_fat": "SaturatedFatContent",
    "cholesterol": "CholesterolContent",
    "sodium": "SodiumContent",
    "carbs": "CarbohydrateContent",
    "fiber": "FiberContent",
    "sugar": "SugarContent",
}


@dataclass
class BuildConfig(Config):
    url: str = MISSING
    sha256: str = MISSING
    min_reviews: int = MISSING
    meals: dict[Meal, list[str]] = field(default_factory=dict)


@dataclass
class Exclusion(Output):
    id: int
    name: str
    reason: str


@dataclass
class Report(Output):
    source: str
    sha256: Annotated[str, "The recipes file's SHA-256, as checked"]
    selected: Annotated[int, "Recipes with min_reviews or more whose category or keywords name a meal"]
    kept: Annotated[int, "Selected recipes written to recipes.json"]
    excluded: Annotated[list[Exclusion], "Selected recipes left out, each with why"]


@dataclass
class RecipesLayout(Layout):
    recipes: Cookbook
    report: Report


def download(url: str, sha256: str, folder: Path) -> Path:
    """The Kaggle download's recipes.parquet, unpacked into ``folder`` and checked against ``sha256``."""
    archive = folder / "download.zip"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request) as response, archive.open("wb") as out:
        while chunk := response.read(1 << 20):
            out.write(chunk)
    with zipfile.ZipFile(archive) as unzipped:
        path = Path(unzipped.extract(PARQUET, folder))
    found = hashlib.sha256(path.read_bytes()).hexdigest()
    if found != sha256:
        raise ValueError(f"{PARQUET} from {url} has SHA-256 {found}, not the configured {sha256}")
    return path


def name_of(row: dict) -> str:
    """The row's recipe name; Food.com HTML-escapes names (`Broccoli &amp; Cheese Soup`)."""
    return html.unescape(row["Name"] or "").strip()


def problem(row: dict) -> str | None:
    """Why a selected Food.com row cannot be a recipe, or None."""
    if not name_of(row):
        return "no name"
    if row["RecipeServings"] is None or row["RecipeServings"] < 1:
        return "no servings"
    for nutrient, column in COLUMNS.items():
        value = row[column]
        if value is None or math.isnan(value):
            return f"no {nutrient}"
        if value < 0:
            return f"negative {nutrient}"
    parts = row["RecipeIngredientParts"] or []
    if not parts or not all(part and part.strip() for part in parts):
        return "an ingredient with no name" if parts else "no ingredients"
    steps = row["RecipeInstructions"] or []
    if not steps or not all(step and step.strip() for step in steps):
        return "an empty step" if steps else "no steps"
    return None


def url_of(row: dict) -> str:
    """The recipe's Food.com page: its name as a slug, then its id."""
    slug = re.sub(r"[^a-z0-9]+", "-", name_of(row).lower()).strip("-")
    return f"https://www.food.com/recipe/{slug}-{int(row['RecipeId'])}"


def recipe(row: dict, meals: list) -> CookbookRecipe:
    labels = {row["RecipeCategory"], *(row["Keywords"] or [])} - {None}
    return CookbookRecipe(
        url=url_of(row),
        meals=meals,
        tags=sorted(labels),
        servings=row["RecipeServings"],
        per_serving=Nutrition(**{nutrient: float(row[column]) for nutrient, column in COLUMNS.items()}),
        ingredients=list(row["RecipeIngredientParts"]),
        steps=list(row["RecipeInstructions"]),
    )


class BuildRecipes(Run):
    """Select Food.com's recipes for each meal, keep the ones with complete data, and report the rest."""

    config: BuildConfig
    layout: RecipesLayout

    def main(self) -> None:
        unknown = [meal.value for meal in Meal if not self.config.meals.get(meal)]
        if unknown:
            raise ValueError(f"meals must name the Food.com labels of every meal; missing: {', '.join(unknown)}")
        with tempfile.TemporaryDirectory() as folder:
            path = download(self.config.url, self.config.sha256, Path(folder))
            columns = ["RecipeId", "Name", "RecipeCategory", "Keywords", "ReviewCount", "RecipeServings"]
            columns += [*COLUMNS.values(), "RecipeIngredientParts", "RecipeInstructions"]
            rows = pq.read_table(path, columns=columns).to_pylist()
        print(f"{len(rows)} Food.com recipes")

        # A row without a review count has no reviews.
        candidates, excluded = [], []
        for row in rows:
            labels = {row["RecipeCategory"], *(row["Keywords"] or [])}
            meals = [meal for meal in Meal if labels & set(self.config.meals[meal])]
            if not meals or (row["ReviewCount"] or 0) < self.config.min_reviews:
                continue
            reason = problem(row)
            if reason:
                excluded.append(Exclusion(id=int(row["RecipeId"]), name=name_of(row), reason=reason))
            else:
                candidates.append((name_of(row), row, meals))
        selected = len(candidates) + len(excluded)
        # Recipes are keyed by name, so a name two selected recipes share names neither.
        counts = Counter(name for name, _, _ in candidates)
        kept = {}
        for name, row, meals in candidates:
            if counts[name] > 1:
                excluded.append(Exclusion(id=int(row["RecipeId"]), name=name, reason="shares its name with another recipe"))
            else:
                kept[name] = recipe(row, meals)

        self.layout.recipes = Cookbook(source=f"{CREDIT}: {self.config.url}", recipes=dict(sorted(kept.items())))
        self.layout.report = Report(
            source=self.config.url,
            sha256=self.config.sha256,
            selected=selected,
            kept=len(kept),
            excluded=sorted(excluded, key=lambda exclusion: exclusion.id),
        )
        for meal in Meal:
            print(f"{meal.value}: {sum(meal in item.meals for item in kept.values())} recipes")
        print(f"kept {len(kept)}, excluded {len(excluded)}")


if __name__ == "__main__":
    BuildRecipes().run()
