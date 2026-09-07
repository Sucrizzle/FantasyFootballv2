import { useEffect, useRef, useState } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import '../styles/shared-panel.css'
import './DraftLogPage.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const DRAFT_BOARD_API_URL = API_BASE_URL ? `${API_BASE_URL}/draft-board` : null
const DRAFT_STATE_API_URL = API_BASE_URL ? `${API_BASE_URL}/draft-state` : null
const DRAFT_ORDER_CONFIG_URL = API_BASE_URL ? `${API_BASE_URL}/config/draft_order` : null
const ROSTER_POSITIONS_CONFIG_URL = API_BASE_URL ? `${API_BASE_URL}/config/roster_positions` : null

async function authHeaders() {
  const session = await fetchAuthSession()
  const idToken = session.tokens?.idToken?.toString()
  return { 'Content-Type': 'application/json', Authorization: idToken }
}

// pick_number is guaranteed gapless and 1-indexed (see DraftState.py), so a
// round is just integer division by team count - no gap handling needed.
function roundOf(pickNumber, numTeams) {
  return Math.floor((pickNumber - 1) / numTeams) + 1
}

// A plain <select> with hundreds of players in it is unusable - this is a
// type-to-filter text box + dropdown instead, matching PositionFilter's
// click-outside-to-close pattern on DraftBoardPage. Only ever used for
// picking the *player* half of an edit; the team half stays a normal
// <select> since there are only ever a handful of teams.
const MAX_VISIBLE_MATCHES = 25

function PlayerCombobox({ rows, value, onChange }) {
  const [query, setQuery] = useState('')
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

  const selectedPlayer = rows.find((r) => `${r.entity_id}|${r.pos}` === value)
  const displayValue = isOpen ? query : (selectedPlayer ? `${selectedPlayer.player_name} (${selectedPlayer.pos}, ${selectedPlayer.team})` : '')

  const matches = rows
    .filter((r) => (r.player_name ?? '').toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, MAX_VISIBLE_MATCHES)

  return (
    <div className="draft-log-player-combobox" ref={containerRef}>
      <input
        type="text"
        placeholder="Search player…"
        value={displayValue}
        onFocus={() => {
          setQuery('')
          setIsOpen(true)
        }}
        onChange={(e) => setQuery(e.target.value)}
      />
      {isOpen && (
        <div className="draft-log-player-combobox-menu">
          {matches.length === 0 && <div className="draft-log-player-combobox-empty">No matches</div>}
          {matches.map((r) => (
            <button
              type="button"
              key={`${r.entity_id}|${r.pos}`}
              onClick={() => {
                onChange(`${r.entity_id}|${r.pos}`)
                setQuery('')
                setIsOpen(false)
              }}
            >
              {r.player_name} ({r.pos}, {r.team})
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function DraftLogPage() {
  const [rows, setRows] = useState([])
  const [picks, setPicks] = useState([])
  const [draftOrder, setDraftOrder] = useState({ draft_type: 'snake', team_order: [] })
  const [totalRounds, setTotalRounds] = useState(1)
  const [loadStatus, setLoadStatus] = useState('loading') // loading | ready | error
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [currentRound, setCurrentRound] = useState(1)
  const [initializedRound, setInitializedRound] = useState(false)
  const [editingPickNumber, setEditingPickNumber] = useState(null)
  const [editTeam, setEditTeam] = useState('')
  const [editEntityKey, setEditEntityKey] = useState('')

  useEffect(() => {
    ;(async () => {
      if (!DRAFT_BOARD_API_URL || !DRAFT_STATE_API_URL || !DRAFT_ORDER_CONFIG_URL || !ROSTER_POSITIONS_CONFIG_URL) {
        setLoadStatus('error')
        setMessage('VITE_API_BASE_URL is not configured yet.')
        return
      }

      try {
        const headers = await authHeaders()
        const [boardRes, draftStateRes, draftOrderRes, rosterRes] = await Promise.all([
          fetch(DRAFT_BOARD_API_URL, { headers }),
          fetch(DRAFT_STATE_API_URL, { headers }),
          fetch(DRAFT_ORDER_CONFIG_URL, { headers }),
          fetch(ROSTER_POSITIONS_CONFIG_URL, { headers }),
        ])
        const [body, picksBody, draftOrderBody, rosterBody] = await Promise.all([
          boardRes.json(),
          draftStateRes.json(),
          draftOrderRes.json(),
          rosterRes.json(),
        ])
        if (!boardRes.ok) throw new Error(body.error || `Request failed with status ${boardRes.status}`)
        if (!draftStateRes.ok) throw new Error(picksBody.error || `Request failed with status ${draftStateRes.status}`)
        if (!draftOrderRes.ok) throw new Error(draftOrderBody.error || `Request failed with status ${draftOrderRes.status}`)
        if (!rosterRes.ok) throw new Error(rosterBody.error || `Request failed with status ${rosterRes.status}`)

        const numTeams = draftOrderBody.team_order?.length || 1
        // Total rounds = total roster slots per team - a standard draft
        // runs exactly that many rounds regardless of how many picks have
        // been made so far.
        const slotsPerTeam = (rosterBody.slots ?? []).reduce((sum, s) => sum + s.count, 0) || 1
        const nextPickRound = roundOf(picksBody.length + 1, numTeams)

        setRows(body)
        setPicks(picksBody)
        setDraftOrder(draftOrderBody)
        setTotalRounds(Math.max(slotsPerTeam, nextPickRound))
        if (!initializedRound) {
          setCurrentRound(Math.min(nextPickRound, slotsPerTeam))
          setInitializedRound(true)
        }
        setLoadStatus('ready')
      } catch (err) {
        setLoadStatus('error')
        setMessage(err.message)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const numTeams = draftOrder.team_order?.length || 1
  const latestPickNumber = picks.length > 0 ? Math.max(...picks.map((p) => p.pick_number)) : null
  const roundPicks = picks
    .filter((p) => roundOf(p.pick_number, numTeams) === currentRound)
    .sort((a, b) => a.pick_number - b.pick_number)

  function startEdit(pick) {
    setEditingPickNumber(pick.pick_number)
    setEditTeam(pick.team)
    setEditEntityKey(`${pick.entity_id}|${pick.pos}`)
  }

  async function saveEdit(pickNumber) {
    const [entity_id, pos] = editEntityKey.split('|')
    setActionError('')
    try {
      const headers = await authHeaders()
      const res = await fetch(`${DRAFT_STATE_API_URL}/${pickNumber}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ team: editTeam, entity_id, pos }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)
      setPicks((prev) => prev.map((p) => (p.pick_number === pickNumber ? body : p)))
      setEditingPickNumber(null)
    } catch (err) {
      setActionError(err.message)
    }
  }

  async function undoPick(pickNumber) {
    setActionError('')
    try {
      const headers = await authHeaders()
      const res = await fetch(`${DRAFT_STATE_API_URL}/${pickNumber}`, { method: 'DELETE', headers })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)
      setPicks((prev) => prev.filter((p) => p.pick_number !== pickNumber))
    } catch (err) {
      setActionError(err.message)
    }
  }

  return (
    <div className="draft-log-page">
      <h2>Draft Log</h2>

      {loadStatus === 'loading' && <p>Loading…</p>}
      {loadStatus === 'error' && <p className="draft-log-status-error">{message}</p>}

      {loadStatus === 'ready' && (
        <>
          {actionError && <p className="draft-log-status-error">{actionError}</p>}

          <div className="draft-log-round-nav">
            <button type="button" onClick={() => setCurrentRound((r) => r - 1)} disabled={currentRound <= 1}>
              ‹ Prev Round
            </button>
            <span>Round {currentRound} of {totalRounds}</span>
            <button
              type="button"
              onClick={() => setCurrentRound((r) => r + 1)}
              disabled={currentRound >= totalRounds}
            >
              Next Round ›
            </button>
          </div>

          {roundPicks.length === 0 ? (
            <p className="draft-log-empty">No picks recorded in this round yet.</p>
          ) : (
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
                {roundPicks.map((pick) => {
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
                              {(draftOrder.team_order ?? []).map((t) => (
                                <option key={t} value={t}>{t}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <PlayerCombobox rows={rows} value={editEntityKey} onChange={setEditEntityKey} />
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
                              <button type="button" onClick={() => undoPick(pick.pick_number)}>Undo</button>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}
