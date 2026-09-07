import { Fragment, useEffect, useRef, useState } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import './DraftBoardPage.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const DRAFT_BOARD_API_URL = API_BASE_URL ? `${API_BASE_URL}/draft-board` : null

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

function PlayerDetailPanel({ row }) {
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
      </div>
    </div>
  )
}

export default function DraftBoardPage() {
  const [rows, setRows] = useState([])
  const [loadStatus, setLoadStatus] = useState('loading') // loading | ready | error
  const [message, setMessage] = useState('')
  const [sortKey, setSortKey] = useState('draft_score')
  const [sortDir, setSortDir] = useState('desc') // asc | desc
  // null = "no filter applied yet" (show everything) - distinct from an
  // empty array, which would mean "user deselected every position."
  const [selectedPositions, setSelectedPositions] = useState(null)
  const [expandedKey, setExpandedKey] = useState(null)
  const [searchText, setSearchText] = useState('')

  useEffect(() => {
    ;(async () => {
      if (!DRAFT_BOARD_API_URL) {
        setLoadStatus('error')
        setMessage('VITE_API_BASE_URL is not configured yet.')
        return
      }

      try {
        const session = await fetchAuthSession()
        const idToken = session.tokens?.idToken?.toString()
        const res = await fetch(DRAFT_BOARD_API_URL, {
          headers: { Authorization: idToken },
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)

        setRows(body)
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
            {sortedRows.map((row) => {
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
                        <PlayerDetailPanel row={row} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
