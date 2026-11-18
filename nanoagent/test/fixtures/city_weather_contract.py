"""Each tool's and task's typed input and output (see nanoagent.plugin.v0001.contract): declarations only."""

from dataclasses import dataclass
from enum import Enum
from typing import Annotated

from slimconfig import Output


class Tool(Enum):
    CITY_WEATHER = "city_weather"
    SCREEN_CITIES = "screen_cities"


class Task(Enum):
    FIND_CITIES = "find-cities"


class Measure(Enum):
    TEMPERATURE_MAX_C = "temperature_max_c"
    TEMPERATURE_MIN_C = "temperature_min_c"
    PRECIPITATION_MM = "precipitation_mm"


class Comparison(Enum):
    AT_LEAST = "at_least"
    AT_MOST = "at_most"


DATE = "The day, YYYY-MM-DD, one that is over in every city (before yesterday's noon in UTC)"


@dataclass
class CityWeather(Output):
    city: Annotated[str, "The city's name"]
    country: Annotated[str, "The city's country"]
    temperature_max_c: Annotated[float, "The day's highest air temperature 2 m above ground, in °C"]
    temperature_min_c: Annotated[float, "The day's lowest air temperature 2 m above ground, in °C"]
    precipitation_mm: Annotated[float, "The day's total rain, showers and snowfall, in mm"]


@dataclass
class CityValue(Output):
    city: Annotated[str, "The city's name"]
    country: Annotated[str, "The city's country"]
    value: Annotated[float, "The city's measure that day, as city_weather gives it"]


@dataclass
class WeatherInput(Output):
    date: Annotated[str, DATE]


@dataclass
class WeatherOutput(Output):
    date: Annotated[str, "The day, as given"]
    cities: Annotated[list[CityWeather], "Every listed city's weather that day, local day, by city"]


@dataclass
class ScreenInput(Output):
    date: Annotated[str, DATE]
    measure: Annotated[Measure, "Which of the day's weather to compare"]
    comparison: Annotated[Comparison, "Whether a city counts at or above the threshold, or at or below it"]
    threshold: Annotated[float, "The measure's threshold, in its unit (°C or mm)"]


@dataclass
class ScreenOutput(Output):
    date: Annotated[str, "The day, as given"]
    measure: Annotated[Measure, "The measure, as given"]
    comparison: Annotated[Comparison, "The comparison, as given"]
    threshold: Annotated[float, "The threshold, as given"]
    cities: Annotated[
        list[CityValue],
        "Every listed city whose measure meets the threshold, most extreme first (highest for at_least, lowest for"
        " at_most), ties by city",
    ]


TOOLS = {
    Tool.CITY_WEATHER: (WeatherInput, WeatherOutput),
    Tool.SCREEN_CITIES: (ScreenInput, ScreenOutput),
}
TASKS = {Task.FIND_CITIES: (ScreenInput, ScreenOutput)}
