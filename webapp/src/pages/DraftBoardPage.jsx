import { Fragment, useEffect, useRef, useState } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import './DraftBoardPage.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const DRAFT_BOARD_API_URL = API_BASE_URL ? `${API_BASE_URL}/draft-board` : null
const HISTORY_API_URL = API_BASE_URL ? `${API_BASE_URL}/draft-board/history` : null
const DRAFT_STATE_API_URL = API_BASE_URL ? `${API_BASE_URL}/draft-state` : null
const DRAFT_ORDER_CONFIG_URL = API_BASE_URL ? `${API_BASE_URL}/config/draft_order` : null

// Snake reverses team_order every other round; round_robin repeats the
// same order every round. pick_number is 1-indexed and guaranteed gapless
// by DraftState.py (server-computed, undo-last-only) - safe to derive
// round/index from it directly with no gap handling needed here.
function computeOnTheClock(draftOrder, pickNumber) {
  const teamOrder = draftOrder?.team_order ?? []
  if (teamOrder.length === 0) return null

  const numTeams = teamOrder.length
  const round = Math.floor((pickNumber - 1) / numTeams)
  const indexInRound = (pickNumber - 1) % numTeams

  if (draftOrder.draft_type === 'snake' && round % 2 === 1) {
    return teamOrder[numTeams - 1 - indexInRound]
  }
  return teamOrder[indexInRound]
}

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

function HistoryChart({ history, replacementValue, projectedValue, color }) {
  const [hoveredKey, setHoveredKey] = useState(null)

  const hasProjection = typeof projectedValue === 'number'

  if (history.length === 0 && !hasProjection) {
    return <p className="draft-detail-history-empty">No season history available.</p>
  }

  // Most recent N seasons, oldest-to-newest for left-to-right rendering -
  // gold produces full history on purpose (see chat), so "how many
  // seasons to show" is entirely a presentation decision made here, not
  // baked into the query.
  const sortedHistory = [...history]
    .sort((a, b) => b.season - a.season)
    .slice(0, HISTORY_SEASON_COUNT)
    .sort((a, b) => a.season - b.season)

  // Upcoming-season projection is deliberately NOT a fact record (see
  // chat) - it's a forward-looking estimate, not an observed season, and
  // it's already sitting on the row from fact_draft_scores with no extra
  // data plumbing needed. Rendered as its own trailing point with a
  // dashed connector, kept visually distinct from real history.
  const points = [
    ...sortedHistory.map((h) => ({ key: `s${h.season}`, label: String(h.season), value: h.fpts_pg, isProjection: false })),
    ...(hasProjection ? [{ key: 'proj', label: 'Proj', value: projectedValue, isProjection: true }] : []),
  ]

  const width = 420
  const height = 150
  const padding = 20

  const scaleX = (i) =>
    padding + (points.length === 1 ? 0 : (i / (points.length - 1)) * (width - padding * 2))
  const scaleY = (v) =>
    height - padding - (Math.min(v, CHART_MAX_PPG) / CHART_MAX_PPG) * (height - padding * 2)

  const historyLinePoints = sortedHistory.map((h, i) => `${scaleX(i)},${scaleY(h.fpts_pg)}`).join(' ')
  const replacementY = scaleY(replacementValue)
  const hoveredIndex = points.findIndex((p) => p.key === hoveredKey)
  const hovered = points[hoveredIndex]

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

      {/* Light halo behind the line so it stays visible regardless of how
          dark a given team's color is - some team colors (navy, black,
          dark green) have very little contrast against a dark background
          on their own. */}
      <polyline className="draft-detail-history-line-halo" points={historyLinePoints} />
      <polyline className="draft-detail-history-line" style={{ stroke: color }} points={historyLinePoints} />

      {hasProjection && sortedHistory.length > 0 && (
        <>
          <line
            className="draft-detail-history-projection-line-halo"
            x1={scaleX(sortedHistory.length - 1)}
            y1={scaleY(sortedHistory[sortedHistory.length - 1].fpts_pg)}
            x2={scaleX(points.length - 1)}
            y2={scaleY(projectedValue)}
          />
          <line
            className="draft-detail-history-projection-line"
            style={{ stroke: color }}
            x1={scaleX(sortedHistory.length - 1)}
            y1={scaleY(sortedHistory[sortedHistory.length - 1].fpts_pg)}
            x2={scaleX(points.length - 1)}
            y2={scaleY(projectedValue)}
          />
        </>
      )}

      {points.map((p, i) => (
        <g key={p.key}>
          <circle
            className="draft-detail-history-dot-halo"
            cx={scaleX(i)}
            cy={scaleY(p.value)}
            r={5}
          />
          <circle
            className={p.isProjection ? 'draft-detail-history-dot-projection' : 'draft-detail-history-dot'}
            style={p.isProjection ? { stroke: color } : { fill: color }}
            cx={scaleX(i)}
            cy={scaleY(p.value)}
            r={3.5}
            onMouseEnter={() => setHoveredKey(p.key)}
            onMouseLeave={() => setHoveredKey((prev) => (prev === p.key ? null : prev))}
          />
        </g>
      ))}

      {points.map((p, i) => (
        <text key={`label-${p.key}`} className="draft-detail-history-axis-label" x={scaleX(i)} y={height - 4}>
          {p.label}
        </text>
      ))}

      {hovered && (
        <g className="draft-detail-history-tooltip">
          <rect x={scaleX(hoveredIndex) - 18} y={scaleY(hovered.value) - 24} width={36} height={16} rx={3} />
          <text x={scaleX(hoveredIndex)} y={scaleY(hovered.value) - 12}>
            {fixed2(hovered.value)}
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
  const isAboveReplacement = row.draft_score >= 0
  // draft_score is already proj_fpts_pg - r_fpts_pg, computed once in SQL
  // - reused directly here rather than resubtracting client-side, so this
  // can't ever drift from the value shown in the main table's own column.
  // toFixed already prefixes "-" for negatives; only "+" needs adding.
  const signedScore = isAboveReplacement ? `+${fixed2(row.draft_score)}` : fixed2(row.draft_score)

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
            {signedScore}
          </span>
        </div>

        <p className="draft-detail-legend">
          <span className="draft-detail-legend-goal" /> Replacement level ({fixed2(row.r_fpts_pg)})
        </p>

        <HistoryChart
          history={history}
          replacementValue={row.r_fpts_pg}
          projectedValue={row.proj_fpts_pg}
          color={barColor}
        />
      </div>
    </div>
  )
}

// Corrections (any pick) vs. undo (last pick only) are genuinely different
// operations server-side - see DraftState.py. Edit-in-place keeps
// pick_number gapless; undo only works on the highest pick_number for the
// same reason.
function DraftLog({ picks, rows, draftOrder, onEdit, onUndo, editError }) {
  const [editingPickNumber, setEditingPickNumber] = useState(null)
  const [editTeam, setEditTeam] = useState('')
  const [editEntityKey, setEditEntityKey] = useState('')

  if (picks.length === 0) {
    return <p className="draft-log-empty">No picks recorded yet.</p>
  }

  const sortedPicks = [...picks].sort((a, b) => b.pick_number - a.pick_number)
  const latestPickNumber = Math.max(...picks.map((p) => p.pick_number))

  function startEdit(pick) {
    setEditingPickNumber(pick.pick_number)
    setEditTeam(pick.team)
    setEditEntityKey(`${pick.entity_id}|${pick.pos}`)
  }

  async function saveEdit(pickNumber) {
    const [entity_id, pos] = editEntityKey.split('|')
    await onEdit(pickNumber, { team: editTeam, entity_id, pos })
    setEditingPickNumber(null)
  }

  return (
    <div className="draft-log">
      <h3>Draft Log</h3>
      {editError && <p className="draft-board-status-error">{editError}</p>}

      <table className="draft-log-table">
        <thead>
          <tr>
            <th>Pick</th>
            <th>Team</th>
            <th>Player</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sortedPicks.map((pick) => {
            const isEditing = editingPickNumber === pick.pick_number
            const player = rows.find((r) => r.entity_id === pick.entity_id && r.pos === pick.pos)
            const isLatest = pick.pick_number === latestPickNumber

            return (
              <tr key={pick.pick_number}>
                <td>#{pick.pick_number}</td>
                {isEditing ? (
                  <>
                    <td>
                      <select value={editTeam} onChange={(e) => setEditTeam(e.target.value)}>
                        {(draftOrder?.team_order ?? []).map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select value={editEntityKey} onChange={(e) => setEditEntityKey(e.target.value)}>
                        {rows.map((r) => (
                          <option key={`${r.entity_id}|${r.pos}`} value={`${r.entity_id}|${r.pos}`}>
                            {r.player_name} ({r.pos}, {r.team})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button type="button" onClick={() => saveEdit(pick.pick_number)}>Save</button>
                      <button type="button" onClick={() => setEditingPickNumber(null)}>Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{pick.team}</td>
                    <td>{player ? `${player.player_name} (${player.pos})` : `${pick.entity_id} (${pick.pos})`}</td>
                    <td>
                      <button type="button" onClick={() => startEdit(pick)}>Edit</button>
                      {isLatest && (
                        <button type="button" onClick={() => onUndo(pick.pick_number)}>Undo</button>
                      )}
                    </td>
                  </>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function DraftBoardPage() {
  const [rows, setRows] = useState([])
  const [historyRows, setHistoryRows] = useState([])
  const [picks, setPicks] = useState([])
  const [draftOrder, setDraftOrder] = useState({ draft_type: 'snake', team_order: [] })
  const [draftError, setDraftError] = useState('')
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
      if (!DRAFT_BOARD_API_URL || !HISTORY_API_URL || !DRAFT_STATE_API_URL || !DRAFT_ORDER_CONFIG_URL) {
        setLoadStatus('error')
        setMessage('VITE_API_BASE_URL is not configured yet.')
        return
      }

      try {
        const session = await fetchAuthSession()
        const idToken = session.tokens?.idToken?.toString()
        const headers = { Authorization: idToken }
        // Fetched once up front, alongside the main board, rather than
        // per-row-click - all four are small, and this avoids extra
        // network round-trips as the user interacts with the board.
        const [boardRes, historyRes, draftStateRes, draftOrderRes] = await Promise.all([
          fetch(DRAFT_BOARD_API_URL, { headers }),
          fetch(HISTORY_API_URL, { headers }),
          fetch(DRAFT_STATE_API_URL, { headers }),
          fetch(DRAFT_ORDER_CONFIG_URL, { headers }),
        ])
        const [body, historyBody, picksBody, draftOrderBody] = await Promise.all([
          boardRes.json(),
          historyRes.json(),
          draftStateRes.json(),
          draftOrderRes.json(),
        ])
        if (!boardRes.ok) throw new Error(body.error || `Request failed with status ${boardRes.status}`)
        if (!historyRes.ok) throw new Error(historyBody.error || `Request failed with status ${historyRes.status}`)
        if (!draftStateRes.ok) throw new Error(picksBody.error || `Request failed with status ${draftStateRes.status}`)
        if (!draftOrderRes.ok) throw new Error(draftOrderBody.error || `Request failed with status ${draftOrderRes.status}`)

        setRows(body)
        setHistoryRows(historyBody)
        setPicks(picksBody)
        setDraftOrder(draftOrderBody)
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

  // pick_number is guaranteed gapless by DraftState.py (server-computed,
  // undo-last-only), so the next pick number is always just the count.
  const pickNumber = picks.length + 1
  const onTheClock = computeOnTheClock(draftOrder, pickNumber)
  const pickedKeys = new Set(picks.map((p) => `${p.entity_id}|${p.pos}`))

  async function draftPlayer(row) {
    if (!DRAFT_STATE_API_URL || !onTheClock) return

    setDraftError('')
    try {
      const session = await fetchAuthSession()
      const idToken = session.tokens?.idToken?.toString()
      const res = await fetch(DRAFT_STATE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: idToken },
        body: JSON.stringify({ team: onTheClock, entity_id: row.entity_id, pos: row.pos }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)

      // Append locally rather than refetching the whole picks list - this
      // response already IS the new pick.
      setPicks((prev) => [...prev, body])
    } catch (err) {
      setDraftError(err.message)
    }
  }

  async function editPick(pickNumber, { team, entity_id, pos }) {
    if (!DRAFT_STATE_API_URL) return

    setDraftError('')
    try {
      const session = await fetchAuthSession()
      const idToken = session.tokens?.idToken?.toString()
      const res = await fetch(`${DRAFT_STATE_API_URL}/${pickNumber}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: idToken },
        body: JSON.stringify({ team, entity_id, pos }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)

      setPicks((prev) => prev.map((p) => (p.pick_number === pickNumber ? body : p)))
    } catch (err) {
      setDraftError(err.message)
    }
  }

  async function undoPick(pickNumber) {
    if (!DRAFT_STATE_API_URL) return

    setDraftError('')
    try {
      const session = await fetchAuthSession()
      const idToken = session.tokens?.idToken?.toString()
      const res = await fetch(`${DRAFT_STATE_API_URL}/${pickNumber}`, {
        method: 'DELETE',
        headers: { Authorization: idToken },
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)

      setPicks((prev) => prev.filter((p) => p.pick_number !== pickNumber))
    } catch (err) {
      setDraftError(err.message)
    }
  }

  return (
    <div className="draft-board-page">
      <h2>Draft Board</h2>

      {loadStatus === 'loading' && <p>Loading…</p>}
      {loadStatus === 'error' && <p className="draft-board-status-error">{message}</p>}

      {loadStatus === 'ready' && (
        <p className="draft-board-status-bar">
          Pick #{pickNumber} — On the clock: <strong>{onTheClock ?? 'unknown'}</strong>
        </p>
      )}
      {draftError && <p className="draft-board-status-error">{draftError}</p>}

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
              <th />
            </tr>
          </thead>
          <tbody>
            {pagedRows.map((row) => {
              const key = `${row.pos}-${row.entity_id}`
              const isExpanded = expandedKey === key
              const isPicked = pickedKeys.has(`${row.entity_id}|${row.pos}`)
              return (
                <Fragment key={key}>
                  <tr
                    className={`draft-board-row ${isPicked ? 'draft-board-row-picked' : ''}`}
                    onClick={() => setExpandedKey(isExpanded ? null : key)}
                  >
                    {COLUMNS.map((col) => (
                      <td key={col.key}>{col.format ? col.format(row[col.key]) : row[col.key]}</td>
                    ))}
                    <td>
                      <button
                        type="button"
                        disabled={isPicked || !onTheClock}
                        onClick={(e) => {
                          e.stopPropagation()
                          draftPlayer(row)
                        }}
                      >
                        {isPicked ? 'Drafted' : 'Draft'}
                      </button>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={COLUMNS.length + 1}>
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

      {loadStatus === 'ready' && (
        <DraftLog
          picks={picks}
          rows={rows}
          draftOrder={draftOrder}
          onEdit={editPick}
          onUndo={undoPick}
          editError={draftError}
        />
      )}
    </div>
  )
}
