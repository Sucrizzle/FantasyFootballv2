import { Fragment, useEffect, useRef, useState } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import './DraftBoardPage.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const DRAFT_BOARD_API_URL = API_BASE_URL ? `${API_BASE_URL}/draft-board` : null

// Column contract matches Lambda/Gold/queries/fact_draft_scores.sql's
// output - only DST exists today, but this table doesn't care how many
// positions are behind it, by design (see chat: the whole point of the
// common entity_id/pos/team/*_fpts_pg/draft_score shape).
const COLUMNS = [
  { key: 'pos', label: 'Pos' },
  { key: 'team', label: 'Team' },
  { key: 'player_name', label: 'Player_Name' },
  { key: 'proj_fpts_pg', label: 'Proj PPG' },
  { key: 'r_fpts_pg', label: 'Replacement PPG' },
  { key: 'draft_score', label: 'Draft Score' },
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

// Plain CSS bars, not a charting library - it's exactly two values on a
// shared scale, which doesn't need anything heavier. The scale is local
// to this row (max of its own two values, plus headroom) rather than
// computed across the whole dataset, so opening one row's panel doesn't
// need to know about every other row.
function PlayerDetailPanel({ row }) {
  const maxScale = Math.max(row.proj_fpts_pg, row.r_fpts_pg) * 1.15 || 1
  const scoreIsPositive = row.draft_score >= 0

  return (
    <div className="draft-detail-panel">
      {row.image_url && (
        <img className="draft-detail-image" src={row.image_url} alt={row.player_name} />
      )}

      <div className="draft-detail-chart">
        <div className="draft-detail-bar-row">
          <span className="draft-detail-bar-label">Projected</span>
          <div className="draft-detail-bar-track">
            <div
              className="draft-detail-bar-fill draft-detail-bar-projected"
              style={{ width: `${(row.proj_fpts_pg / maxScale) * 100}%` }}
            />
          </div>
          <span className="draft-detail-bar-value">{row.proj_fpts_pg}</span>
        </div>

        <div className="draft-detail-bar-row">
          <span className="draft-detail-bar-label">Replacement</span>
          <div className="draft-detail-bar-track">
            <div
              className="draft-detail-bar-fill draft-detail-bar-replacement"
              style={{ width: `${(row.r_fpts_pg / maxScale) * 100}%` }}
            />
          </div>
          <span className="draft-detail-bar-value">{row.r_fpts_pg}</span>
        </div>

        <p className={scoreIsPositive ? 'draft-detail-score-positive' : 'draft-detail-score-negative'}>
          Draft Score: {scoreIsPositive ? '+' : ''}{row.draft_score}
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

  const filteredRows =
    selectedPositions === null ? rows : rows.filter((r) => selectedPositions.includes(r.pos))

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
        <PositionFilter
          allPositions={allPositions}
          selectedPositions={selectedPositions}
          onToggle={togglePosition}
        />
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
                      <td key={col.key}>{row[col.key]}</td>
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
