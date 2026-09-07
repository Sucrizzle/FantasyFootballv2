import { Fragment, useEffect, useRef, useState } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import './DraftBoardPage.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const DRAFT_BOARD_API_URL = API_BASE_URL ? `${API_BASE_URL}/draft-board` : null
const HISTORY_API_URL = API_BASE_URL ? `${API_BASE_URL}/draft-board/history` : null

// Column contract matches Lambda/Gold/queries/fact_draft_scores.sql's
// output - only DST exists today, but this table doesn't care how many
// positions are behind it, by design (see chat: the whole point of the
// common entity_id/pos/team/*_fpts_pg/draft_score shape).
// toFixed(2) here is purely a display concern, applied only when
// rendering a cell - the underlying row values stay real numbers so
// sorting keeps working correctly. A number like 6.3 round-trips through
// JSON/JS with no memory of trailing zeros; only explicit formatting
// forces "always 2 decimal places" on screen.
const fixed2 = (v) => (typeof v === 'number' ? v.toFixed(2) : v)

// Accounting-style negatives - (1.23) instead of -1.23 - uncolored,
// just this one formatting change for draft_score specifically.
const formatDraftScore = (v) => (typeof v === 'number' ? (v < 0 ? `(${Math.abs(v).toFixed(2)})` : v.toFixed(2)) : v)

// Purely a rendering concern, applied after filter/search/sort - see chat:
// pagination must never change what's searchable, only how much of the
// already-filtered/sorted result renders at once.
const PAGE_SIZE_OPTIONS = [15, 25, 50, 100]
const DEFAULT_PAGE_SIZE = 15

const COLUMNS = [
  { key: 'pos', label: 'Pos' },
  { key: 'team', label: 'Team' },
  { key: 'player_name', label: 'Player_Name' },
  { key: 'proj_fpts_pg', label: 'Proj PPG', format: fixed2 },
  { key: 'draft_score', label: 'Draft Score', format: formatDraftScore },
]

// Standard "dropdown that expands into checkboxes" pattern - a native
// <select multiple> would technically be a multi-select, but it renders
// as an always-open list box, not a collapsed dropdown, so it doesn't
// really match what was asked for.
function PositionFilter({ allPositions, selectedPositions, onToggle }) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef(null)

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const effectiveSelected = selectedPositions ?? allPositions
  const label =
    effectiveSelected.length === allPositions.length
      ? 'All Positions'
      : effectiveSelected.length === 0
        ? 'No Positions'
        : effectiveSelected.join(', ')

  return (
    <div className="draft-board-position-filter" ref={containerRef}>
      <button type="button" onClick={() => setIsOpen((prev) => !prev)}>
        {label} ▾
      </button>
      {isOpen && (
        <div className="draft-board-position-filter-menu">
          {allPositions.map((pos) => (
            <label key={pos}>
              <input
                type="checkbox"
                checked={effectiveSelected.includes(pos)}
                onChange={() => onToggle(pos)}
              />
              {pos}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// Plain CSS, not a charting library - one bar (team-colored, projected
// PPG) plus a vertical "goal line" marker at the replacement value on the
// same track, rather than two separate bars.
//
// Fixed scale (not "max of this row's own two values") deliberately - a
// per-row scale makes every bar look similarly full regardless of actual
// magnitude, which defeats comparing impact across rows/positions. 30 is
// comfortably above any realistic weekly PPG for this scoring config;
// revisit if a position/scoring change ever pushes real values close to
// or past it.
const CHART_MAX_PPG = 30

// Plain inline SVG, not a charting library - a handful of points and one
// reference line doesn't need anything heavier, same reasoning as the bar
// chart above. Shares CHART_MAX_PPG with the bar chart so a viewer can
// trust "tall" means the same thing in both charts within one panel.
const HISTORY_SEASON_COUNT = 5

function HistoryChart({ history, replacementValue, color }) {
  const [hoveredSeason, setHoveredSeason] = useState(null)

  if (history.length === 0) {
    return <p className="draft-detail-history-empty">No season history available.</p>
  }

  // Most recent N seasons, oldest-to-newest for left-to-right rendering -
  // gold produces full history on purpose (see chat), so "how many
  // seasons to show" is entirely a presentation decision made here, not
  // baked into the query.
  const sorted = [...history]
    .sort((a, b) => b.season - a.season)
    .slice(0, HISTORY_SEASON_COUNT)
    .sort((a, b) => a.season - b.season)

  const width = 420
  const height = 150
  const padding = 20

  const scaleX = (i) =>
    padding + (sorted.length === 1 ? 0 : (i / (sorted.length - 1)) * (width - padding * 2))
  const scaleY = (v) =>
    height - padding - (Math.min(v, CHART_MAX_PPG) / CHART_MAX_PPG) * (height - padding * 2)

  const linePoints = sorted.map((h, i) => `${scaleX(i)},${scaleY(h.fpts_pg)}`).join(' ')
  const replacementY = scaleY(replacementValue)
  const hovered = sorted.find((h) => h.season === hoveredSeason)

  return (
    <svg
      className="draft-detail-history-chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <line
        className="draft-detail-history-goal"
        x1={padding}
        x2={width - padding}
        y1={replacementY}
        y2={replacementY}
      />

      {/* Light halo behind the line/dots so they stay visible regardless
          of how dark a given team's color is - some team colors (navy,
          black, dark green) have very little contrast against a dark
          background on their own. */}
      <polyline className="draft-detail-history-line-halo" points={linePoints} />
      <polyline className="draft-detail-history-line" style={{ stroke: color }} points={linePoints} />

      {sorted.map((h, i) => (
        <g key={h.season}>
          <circle
            className="draft-detail-history-dot-halo"
            cx={scaleX(i)}
            cy={scaleY(h.fpts_pg)}
            r={5}
          />
          <circle
            className="draft-detail-history-dot"
            style={{ fill: color }}
            cx={scaleX(i)}
            cy={scaleY(h.fpts_pg)}
            r={3.5}
            onMouseEnter={() => setHoveredSeason(h.season)}
            onMouseLeave={() => setHoveredSeason((prev) => (prev === h.season ? null : prev))}
          />
        </g>
      ))}

      {sorted.map((h, i) => (
        <text
          key={`label-${h.season}`}
          className="draft-detail-history-axis-label"
          x={scaleX(i)}
          y={height - 4}
        >
          {h.season}
        </text>
      ))}

      {hovered && (
        <g className="draft-detail-history-tooltip">
          <rect
            x={scaleX(sorted.indexOf(hovered)) - 18}
            y={scaleY(hovered.fpts_pg) - 24}
            width={36}
            height={16}
            rx={3}
          />
          <text x={scaleX(sorted.indexOf(hovered))} y={scaleY(hovered.fpts_pg) - 12}>
            {fixed2(hovered.fpts_pg)}
          </text>
        </g>
      )}
    </svg>
  )
}

function PlayerDetailPanel({ row, history }) {
  const projectedPct = Math.min((row.proj_fpts_pg / CHART_MAX_PPG) * 100, 100)
  const replacementPct = Math.min((row.r_fpts_pg / CHART_MAX_PPG) * 100, 100)
  const barColor = row.team_color || 'var(--accent)'
  const isAboveReplacement = row.proj_fpts_pg >= row.r_fpts_pg

  return (
    <div className="draft-detail-panel">
      {row.image_url && (
        <img className="draft-detail-image" src={row.image_url} alt={row.player_name} />
      )}

      <div className="draft-detail-chart">
        <div className="draft-detail-bar-row">
          <span className="draft-detail-bar-label">Proj PPG</span>
          <div className="draft-detail-bar-track">
            <div
              className="draft-detail-bar-fill"
              style={{ width: `${projectedPct}%`, background: barColor }}
            />
            <div
              className="draft-detail-bar-goal"
              style={{ left: `${replacementPct}%` }}
              title={`Replacement level: ${fixed2(row.r_fpts_pg)}`}
            />
          </div>
          <span
            className={`draft-detail-bar-value ${
              isAboveReplacement ? 'draft-detail-bar-value-positive' : 'draft-detail-bar-value-negative'
            }`}
          >
            {fixed2(row.proj_fpts_pg)}
          </span>
        </div>

        <p className="draft-detail-legend">
          <span className="draft-detail-legend-goal" /> Replacement level ({fixed2(row.r_fpts_pg)})
        </p>

        <HistoryChart history={history} replacementValue={row.r_fpts_pg} color={barColor} />
      </div>
    </div>
  )
}

export default function DraftBoardPage() {
  const [rows, setRows] = useState([])
  const [historyRows, setHistoryRows] = useState([])
  const [loadStatus, setLoadStatus] = useState('loading') // loading | ready | error
  const [message, setMessage] = useState('')
  const [sortKey, setSortKey] = useState('draft_score')
  const [sortDir, setSortDir] = useState('desc') // asc | desc
  // null = "no filter applied yet" (show everything) - distinct from an
  // empty array, which would mean "user deselected every position."
  const [selectedPositions, setSelectedPositions] = useState(null)
  const [expandedKey, setExpandedKey] = useState(null)
  const [searchText, setSearchText] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)

  // Reset to page 1 whenever the filtered set (or the page size itself)
  // changes shape - otherwise it's easy to end up sitting on "page 6" of
  // a result set that now only has 2 pages, looking at an empty table for
  // no visible reason.
  //
  // Adjusted during render, not in a useEffect - this is React's own
  // recommended pattern for "reset state when other state changes"
  // (see "You Might Not Need An Effect"): calling setState mid-render
  // bails out and re-renders immediately with the reset applied, before
  // anything commits to the screen, rather than committing once and then
  // re-rendering a beat later via an effect.
  const filterKey = `${searchText}|${JSON.stringify(selectedPositions)}|${pageSize}`
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey)
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey)
    setCurrentPage(1)
  }

  useEffect(() => {
    ;(async () => {
      if (!DRAFT_BOARD_API_URL || !HISTORY_API_URL) {
        setLoadStatus('error')
        setMessage('VITE_API_BASE_URL is not configured yet.')
        return
      }

      try {
        const session = await fetchAuthSession()
        const idToken = session.tokens?.idToken?.toString()
        // Fetched once up front, alongside the main board, rather than
        // per-row-click - the whole history table is small, and this
        // avoids a network round-trip every time a row is expanded.
        const [boardRes, historyRes] = await Promise.all([
          fetch(DRAFT_BOARD_API_URL, { headers: { Authorization: idToken } }),
          fetch(HISTORY_API_URL, { headers: { Authorization: idToken } }),
        ])
        const [body, historyBody] = await Promise.all([boardRes.json(), historyRes.json()])
        if (!boardRes.ok) throw new Error(body.error || `Request failed with status ${boardRes.status}`)
        if (!historyRes.ok) throw new Error(historyBody.error || `Request failed with status ${historyRes.status}`)

        setRows(body)
        setHistoryRows(historyBody)
        setLoadStatus('ready')
      } catch (err) {
        setLoadStatus('error')
        setMessage(err.message)
      }
    })()
  }, [])

  function toggleSort(key) {
    if (key === sortKey) {
      setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  // Built from whatever the data actually contains, not hardcoded - stays
  // correct as more positions get added without a code change here.
  const allPositions = [...new Set(rows.map((r) => r.pos))].sort()

  function togglePosition(pos) {
    setSelectedPositions((prev) => {
      const current = prev ?? allPositions
      return current.includes(pos) ? current.filter((p) => p !== pos) : [...current, pos]
    })
  }

  const filteredRows = rows
    .filter((r) => selectedPositions === null || selectedPositions.includes(r.pos))
    .filter((r) => (r.player_name ?? '').toLowerCase().includes(searchText.trim().toLowerCase()))

  const sortedRows = [...filteredRows].sort((a, b) => {
    const av = a[sortKey]
    const bv = b[sortKey]
    if (av == null) return 1
    if (bv == null) return -1
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))
    return sortDir === 'asc' ? cmp : -cmp
  })

  const totalPages = Math.max(Math.ceil(sortedRows.length / pageSize), 1)
  // Defensive clamp on top of the reset-on-filter-change effect above -
  // if currentPage ever ends up past the end (e.g. a filter shrinks the
  // result set right at a page boundary), fall back to the last real page
  // rather than rendering nothing.
  const safePage = Math.min(currentPage, totalPages)
  const pagedRows = sortedRows.slice((safePage - 1) * pageSize, safePage * pageSize)

  return (
    <div className="draft-board-page">
      <h2>Draft Board</h2>

      {loadStatus === 'loading' && <p>Loading…</p>}
      {loadStatus === 'error' && <p className="draft-board-status-error">{message}</p>}

      {loadStatus === 'ready' && (
        <div className="draft-board-controls">
          <PositionFilter
            allPositions={allPositions}
            selectedPositions={selectedPositions}
            onToggle={togglePosition}
          />
          <input
            type="text"
            className="draft-board-search"
            placeholder="Search player name…"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          <label className="draft-board-page-size">
            Per page
            <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      {loadStatus === 'ready' && (
        <table className="draft-board-table">
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th key={col.key} onClick={() => toggleSort(col.key)}>
                  {col.label}
                  {sortKey === col.key && (sortDir === 'desc' ? ' ▼' : ' ▲')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pagedRows.map((row) => {
              const key = `${row.pos}-${row.entity_id}`
              const isExpanded = expandedKey === key
              return (
                <Fragment key={key}>
                  <tr
                    className="draft-board-row"
                    onClick={() => setExpandedKey(isExpanded ? null : key)}
                  >
                    {COLUMNS.map((col) => (
                      <td key={col.key}>{col.format ? col.format(row[col.key]) : row[col.key]}</td>
                    ))}
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={COLUMNS.length}>
                        <PlayerDetailPanel
                          row={row}
                          history={historyRows.filter(
                            (h) => h.entity_id === row.entity_id && h.pos === row.pos,
                          )}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}

      {loadStatus === 'ready' && totalPages > 1 && (
        <div className="draft-board-pagination">
          <button type="button" onClick={() => setCurrentPage((p) => p - 1)} disabled={safePage <= 1}>
            ‹ Prev
          </button>
          <span>
            Page {safePage} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setCurrentPage((p) => p + 1)}
            disabled={safePage >= totalPages}
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  )
}
