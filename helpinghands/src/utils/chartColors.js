// Categorical hue palette shared by the dashboard charts. The stats and
// analytics pages cycle these ten HSL hues across their keyword clouds and bar
// charts via `hues[i % hues.length]`, so the palette is defined once here and
// imported wherever a chart needs it. The order and values are load bearing:
// each index maps to a specific word or bar, so changing them recolors every
// existing chart. (The analytics pie chart keeps its own divergent palette and
// is intentionally not derived from this constant.)
export const CHART_HUES = [210, 340, 150, 30, 270, 180, 0, 60, 300, 120];
