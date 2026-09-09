import { Fragment, useEffect, useRef, useState } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import { computeSlotFill } from '../lib/rosterSlots'
import './DraftBoardPage.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const DRAFT_BOARD_API_URL = API_BASE_URL ? `${API_BASE_URL}/draft-board` : null
const HISTORY_API_URL = API_BASE_URL ? `${API_BASE_URL}/draft-board/history` : null
const DRAFT_STATE_API_URL = API_BASE_URL ? `${API_BASE_URL}/draft-state` : null
const DRAFT_ORDER_CONFIG_URL = API_BASE_URL ? `${API_BASE_URL}/config/draft_order` : null
const MY_TEAM_CONFIG_URL = API_BASE_URL ? `${API_BASE_URL}/config/my_team` : null
const ROSTER_POSITIONS_CONFIG_URL = API_BASE_URL ? `${API_BASE_URL}/config/roster_positions` : null
const DRAFT_URGENCY_API_URL = API_BASE_URL ? `${API_BASE_URL}/draft-urgency` : null

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

// Only player_name's formatter needs the whole row (is_rookie/is_active
// live alongside it, not on the name itself) - every other column's
// formatter ignores the second argument.
//
// is_active checked with === false, not just falsy - a player whose
// dim_player join didn't match at all comes through as null/undefined
// (unknown), which shouldn't be labeled "not active" the same way a real
// false does.
const formatPlayerName = (name, row) => (
  <>
    {name}
    {row?.is_rookie && <span className="draft-board-rookie-badge" title="Rookie">R</span>}
    {row?.is_active === false && <span className="draft-board-inactive-badge" title="Not on an active roster">NA</span>}
  </>
)

// Purely a rendering concern, applied after filter/search/sort - see chat:
// pagination must never change what's searchable, only how much of the
// already-filtered/sorted result renders at once.
const PAGE_SIZE_OPTIONS = [15, 25, 50, 100]
const DEFAULT_PAGE_SIZE = 15

const COLUMNS = [
  { key: 'pos', label: 'Pos' },
  { key: 'team', label: 'Team' },
  { key: 'player_name', label: 'Player_Name', format: formatPlayerName },
  { key: 'adp_rank', label: 'ADP', format: (v) => (typeof v === 'number' ? v : '—') },
  { key: 'proj_fpts_pg', label: 'Proj PPG', format: fixed2 },
  { key: 'draft_score', label: 'Draft Score', format: formatDraftScore },
  { key: 'urgency_score', label: 'Urgency', format: formatDraftScore },
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

function HistoryChart({ history, replacementValue, projectedValue, color, availabilityColor }) {
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
  // Separate 0-1 domain sharing the same pixel range as the PPG axis, so
  // availability's 1.00 lands on the exact same top pixel as CHART_MAX_PPG
  // does for PPG - a genuine second scale on the same chart, not PPG
  // rescaled to fit availability's range.
  const scaleYAvailability = (v) =>
    height - padding - (Math.min(v, 1) / 1) * (height - padding * 2)

  const historyLinePoints = sortedHistory.map((h, i) => `${scaleX(i)},${scaleY(h.fpts_pg)}`).join(' ')
  // Same x positions as the PPG line (shared index into sortedHistory) -
  // only real history has availability, there's no projected-availability
  // point to add alongside the PPG projection.
  const availabilityPoints = sortedHistory
    .map((h, i) =>
      h.availability != null
        ? { key: `avail-s${h.season}`, x: scaleX(i), y: scaleYAvailability(h.availability), value: h.availability }
        : null,
    )
    .filter(Boolean)
  const availabilityLinePoints = availabilityPoints.map((p) => `${p.x},${p.y}`).join(' ')
  const replacementY = scaleY(replacementValue)
  const hoveredIndex = points.findIndex((p) => p.key === hoveredKey)
  const hoveredPpg = points[hoveredIndex]
  const hoveredAvailability = availabilityPoints.find((p) => p.key === hoveredKey)
  // Shared tooltip for both series - only one dot can be hovered at a time,
  // so whichever array actually matched hoveredKey wins. PPG values format
  // via the same fixed2 the rest of the board uses; availability (a 0-1
  // fraction) uses its own decimal precision so "0.94" doesn't round away
  // the only digit that matters at this scale.
  const hovered = hoveredPpg
    ? { x: scaleX(hoveredIndex), y: scaleY(hoveredPpg.value), label: fixed2(hoveredPpg.value) }
    : hoveredAvailability
      ? { x: hoveredAvailability.x, y: hoveredAvailability.y, label: hoveredAvailability.value.toFixed(2) }
      : null

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

      {/* Availability - second line, own 0-1 scale (see scaleYAvailability
          above). Uses the team's secondary color (team_color2), not the
          primary team_color the PPG line already uses - two lines the same
          color on the same chart would be indistinguishable. */}
      <polyline className="draft-detail-history-availability-line-halo" points={availabilityLinePoints} />
      <polyline
        className="draft-detail-history-availability-line"
        style={{ stroke: availabilityColor }}
        points={availabilityLinePoints}
      />
      {availabilityPoints.map((p) => (
        <circle
          key={p.key}
          className="draft-detail-history-availability-dot"
          style={{ fill: availabilityColor }}
          cx={p.x}
          cy={p.y}
          r={3}
          onMouseEnter={() => setHoveredKey(p.key)}
          onMouseLeave={() => setHoveredKey((prev) => (prev === p.key ? null : prev))}
        />
      ))}
      <text className="draft-detail-history-axis-label-right" x={width - padding} y={padding + 4}>1.00</text>
      <text className="draft-detail-history-axis-label-right" x={width - padding} y={height - padding + 4}>0</text>

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
          <rect x={hovered.x - 18} y={hovered.y - 24} width={36} height={16} rx={3} />
          <text x={hovered.x} y={hovered.y - 12}>
            {hovered.label}
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
  const availabilityColor = row.team_color2 || 'var(--accent)'
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
        <p className="draft-detail-legend">
          Tier: {typeof row.tier === 'number' ? row.tier : '—'}
        </p>

        <HistoryChart
          history={history}
          replacementValue={row.r_fpts_pg}
          availabilityColor={availabilityColor}
          projectedValue={row.proj_fpts_pg}
          color={barColor}
        />
      </div>
    </div>
  )
}

export default function DraftBoardPage() {
  const [rows, setRows] = useState([])
  const [historyRows, setHistoryRows] = useState([])
  const [picks, setPicks] = useState([])
  const [draftOrder, setDraftOrder] = useState({ draft_type: 'snake', team_order: [] })
  const [myTeam, setMyTeam] = useState(null)
  const [rosterPositions, setRosterPositions] = useState({ slots: [] })
  // entity_id|pos -> urgency_score, from the DraftUrgency Lambda. Fetched
  // and failed independently of the rest of the board (see below) - it's
  // a live recommendation layer on top of the board, not core data the
  // page can't function without.
  const [urgencyByKey, setUrgencyByKey] = useState({})
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
  const filterKey = `${searchText}|${JSON.stringify(selectedPositions)}|${pageSize}|${sortKey}|${sortDir}`
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey)
  if (filterKey !== prevFilterKey) {
    setPrevFilterKey(filterKey)
    setCurrentPage(1)
  }

  // Urgency depends on live draft state (survival probability shifts with
  // every real pick, need_multiplier shifts with every pick affecting your
  // own roster) - unlike the rest of the board data, it goes stale the
  // instant a pick happens anywhere, not just on page load. Pulled out as
  // its own function so draftPlayer can call it again after a successful
  // pick, not just once on mount.
  //
  // Independent try/catch, not thrown into whatever caller's error
  // handling - the board is fully usable without urgency scores (Draft
  // Score alone still works), so a missing/erroring DraftUrgency Lambda
  // shouldn't block the page from loading OR a pick from registering.
  async function refreshUrgency() {
    if (!DRAFT_URGENCY_API_URL) return
    try {
      const session = await fetchAuthSession()
      const idToken = session.tokens?.idToken?.toString()
      const urgencyRes = await fetch(DRAFT_URGENCY_API_URL, { headers: { Authorization: idToken } })
      const urgencyBody = await urgencyRes.json()
      if (!urgencyRes.ok) throw new Error(urgencyBody.error || `Request failed with status ${urgencyRes.status}`)
      const byKey = {}
      for (const u of urgencyBody) {
        byKey[`${u.entity_id}|${u.pos}`] = u.urgency_score
      }
      setUrgencyByKey(byKey)
    } catch (err) {
      // Silent - urgency_score just won't populate/update, same as if the
      // Lambda hasn't been deployed yet.
      console.warn('Draft urgency unavailable:', err.message)
    }
  }

  useEffect(() => {
    ;(async () => {
      if (
        !DRAFT_BOARD_API_URL ||
        !HISTORY_API_URL ||
        !DRAFT_STATE_API_URL ||
        !DRAFT_ORDER_CONFIG_URL ||
        !MY_TEAM_CONFIG_URL ||
        !ROSTER_POSITIONS_CONFIG_URL
      ) {
        setLoadStatus('error')
        setMessage('VITE_API_BASE_URL is not configured yet.')
        return
      }

      try {
        const session = await fetchAuthSession()
        const idToken = session.tokens?.idToken?.toString()
        const headers = { Authorization: idToken }
        // Fetched once up front, alongside the main board, rather than
        // per-row-click - all six are small, and this avoids extra
        // network round-trips as the user interacts with the board.
        const [boardRes, historyRes, draftStateRes, draftOrderRes, myTeamRes, rosterRes] = await Promise.all([
          fetch(DRAFT_BOARD_API_URL, { headers }),
          fetch(HISTORY_API_URL, { headers }),
          fetch(DRAFT_STATE_API_URL, { headers }),
          fetch(DRAFT_ORDER_CONFIG_URL, { headers }),
          fetch(MY_TEAM_CONFIG_URL, { headers }),
          fetch(ROSTER_POSITIONS_CONFIG_URL, { headers }),
        ])
        const [body, historyBody, picksBody, draftOrderBody, myTeamBody, rosterBody] = await Promise.all([
          boardRes.json(),
          historyRes.json(),
          draftStateRes.json(),
          draftOrderRes.json(),
          myTeamRes.json(),
          rosterRes.json(),
        ])
        if (!boardRes.ok) throw new Error(body.error || `Request failed with status ${boardRes.status}`)
        if (!historyRes.ok) throw new Error(historyBody.error || `Request failed with status ${historyRes.status}`)
        if (!draftStateRes.ok) throw new Error(picksBody.error || `Request failed with status ${draftStateRes.status}`)
        if (!draftOrderRes.ok) throw new Error(draftOrderBody.error || `Request failed with status ${draftOrderRes.status}`)
        if (!myTeamRes.ok) throw new Error(myTeamBody.error || `Request failed with status ${myTeamRes.status}`)
        if (!rosterRes.ok) throw new Error(rosterBody.error || `Request failed with status ${rosterRes.status}`)

        setRows(body)
        setHistoryRows(historyBody)
        setPicks(picksBody)
        setDraftOrder(draftOrderBody)
        setMyTeam(myTeamBody.team_name ?? null)
        setRosterPositions(rosterBody)
        setLoadStatus('ready')

        await refreshUrgency()
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

  // Drafted players are removed from the board entirely, not just dimmed -
  // once picked, there's nothing left to decide about them here (edits/undo
  // live on the Draft Log page instead).
  const pickedKeys = new Set(picks.map((p) => `${p.entity_id}|${p.pos}`))
  const undraftedRows = rows.filter((r) => !pickedKeys.has(`${r.entity_id}|${r.pos}`))

  // pick_number is guaranteed gapless by DraftState.py (server-computed,
  // undo-last-only), so the next pick number is always just the count.
  const pickNumber = picks.length + 1
  const onTheClock = computeOnTheClock(draftOrder, pickNumber)

  const filteredRows = undraftedRows
    .map((r) => ({ ...r, urgency_score: urgencyByKey[`${r.entity_id}|${r.pos}`] ?? null }))
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

  const myTeamSlotFill = myTeam ? computeSlotFill(picks, myTeam, rosterPositions) : []

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
      // Unlike picks, urgency can't be updated locally - survival
      // probability and need_multiplier both depend on the live draft
      // state in ways that would require redoing the whole calculation
      // client-side, so this just asks the Lambda to redo it instead.
      refreshUrgency()
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

      {loadStatus === 'ready' && myTeam && (
        <div className="draft-board-my-team">
          <strong>{myTeam} (My Team)</strong>
          <div className="draft-board-my-team-slots">
            {myTeamSlotFill.map((s) => (
              <span
                key={s.slot_name}
                className={`draft-board-slot-chip ${s.open === 0 ? 'draft-board-slot-chip-full' : ''}`}
              >
                {s.slot_name} {s.filled}/{s.count}
              </span>
            ))}
          </div>
        </div>
      )}

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
              return (
                <Fragment key={key}>
                  <tr
                    className="draft-board-row"
                    onClick={() => setExpandedKey(isExpanded ? null : key)}
                  >
                    {COLUMNS.map((col) => (
                      <td key={col.key}>{col.format ? col.format(row[col.key], row) : row[col.key]}</td>
                    ))}
                    <td>
                      <button
                        type="button"
                        disabled={!onTheClock}
                        onClick={(e) => {
                          e.stopPropagation()
                          draftPlayer(row)
                        }}
                      >
                        Draft
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
    </div>
  )
}
