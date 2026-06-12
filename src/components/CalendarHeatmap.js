import React from 'react';

/**
 * Shared GitHub-style calendar heatmap render markup, extracted from the two
 * heatmaps on the analytics page (the Activity Heatmap and the Writing Activity
 * heatmap). The two sections rendered the same weeks-to-columns grid and the
 * same "Less ... More" swatch legend; only a handful of details differed.
 *
 * All data preparation stays with the caller. Pass the already-computed `weeks`
 * (from buildHeatmapWeeks) plus the parts that vary between the two heatmaps.
 * This component renders only the grid of 12x12 cells and the legend; the caller
 * keeps its own section heading and any surrounding chrome.
 *
 * @param {object} props
 * @param {Array<Array<{key: string, count: number}|null>>} props.weeks
 *        Heatmap columns; each entry is a cell or null (an empty pad slot).
 * @param {(count: number) => string} props.cellColor
 *        Maps a real cell's count to its background color.
 * @param {(cell: {key: string, count: number}) => string} props.cellTitle
 *        Builds a real cell's tooltip text.
 * @param {number} [props.columnGap=2] Horizontal gap between week columns.
 * @param {string[]|null} [props.dayLabels=null] Seven day-of-week labels shown in
 *        a leading column, or null to omit the label column.
 * @param {string[]} [props.legendColors=[]] Ordered swatch backgrounds, Less to More.
 * @param {object} [props.legendStyle] Inline style for the legend container.
 * @param {object} [props.legendSwatchWrapStyle] Inline style for the swatch row wrapper.
 * @param {boolean} [props.legendSpaced=false] Pad the legend text with literal
 *        spaces around the swatches (for the non-flex legend layout).
 */
export default function CalendarHeatmap({
  weeks,
  cellColor,
  cellTitle,
  columnGap = 2,
  dayLabels = null,
  legendColors = [],
  legendStyle,
  legendSwatchWrapStyle,
  legendSpaced = false,
}) {
  return (
    <>
      <div style={{ display: 'flex', gap: columnGap, overflow: 'auto', padding: '4px 0' }}>
        {dayLabels && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 4, paddingTop: 0 }}>
            {dayLabels.map((label, i) => (
              <div
                key={i}
                style={{
                  width: 28,
                  height: 12,
                  fontSize: '0.6rem',
                  color: 'var(--ifm-color-emphasis-500)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  paddingRight: 4,
                  visibility: (i === 1 || i === 3 || i === 5) ? 'visible' : 'hidden',
                }}
              >
                {label}
              </div>
            ))}
          </div>
        )}
        {weeks.map((w, wi) => (
          <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {w.map((cell, di) => (
              <div
                key={di}
                title={cell ? cellTitle(cell) : ''}
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  background: cell ? cellColor(cell.count) : 'transparent',
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <div style={legendStyle}>
        {legendSpaced ? 'Less ' : 'Less'}
        <span style={legendSwatchWrapStyle}>
          {legendColors.map((bg, i) => (
            <span
              key={i}
              style={{ width: 10, height: 10, borderRadius: 2, display: 'inline-block', background: bg }}
            />
          ))}
        </span>
        {legendSpaced ? ' More' : 'More'}
      </div>
    </>
  );
}
