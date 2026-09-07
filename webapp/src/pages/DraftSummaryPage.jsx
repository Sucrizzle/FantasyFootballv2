import { useEffect, useState } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import { computeSlotFill } from '../lib/rosterSlots'
import '../styles/shared-panel.css'
import './DraftSummaryPage.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const DRAFT_STATE_API_URL = API_BASE_URL ? `${API_BASE_URL}/draft-state` : null
const TEAMS_CONFIG_URL = API_BASE_URL ? `${API_BASE_URL}/config/teams` : null
const MY_TEAM_CONFIG_URL = API_BASE_URL ? `${API_BASE_URL}/config/my_team` : null
const DRAFT_ORDER_CONFIG_URL = API_BASE_URL ? `${API_BASE_URL}/config/draft_order` : null
const ROSTER_POSITIONS_CONFIG_URL = API_BASE_URL ? `${API_BASE_URL}/config/roster_positions` : null

async function authHeaders() {
  const session = await fetchAuthSession()
  const idToken = session.tokens?.idToken?.toString()
  return { Authorization: idToken }
}

export default function DraftSummaryPage() {
  const [picks, setPicks] = useState([])
  const [teamOrder, setTeamOrder] = useState([])
  const [myTeam, setMyTeam] = useState(null)
  const [rosterPositions, setRosterPositions] = useState({ slots: [] })
  const [loadStatus, setLoadStatus] = useState('loading') // loading | ready | error
  const [message, setMessage] = useState('')

  useEffect(() => {
    ;(async () => {
      if (!DRAFT_STATE_API_URL || !TEAMS_CONFIG_URL || !MY_TEAM_CONFIG_URL || !DRAFT_ORDER_CONFIG_URL || !ROSTER_POSITIONS_CONFIG_URL) {
        setLoadStatus('error')
        setMessage('VITE_API_BASE_URL is not configured yet.')
        return
      }

      try {
        const headers = await authHeaders()
        const [picksRes, teamsRes, myTeamRes, draftOrderRes, rosterRes] = await Promise.all([
          fetch(DRAFT_STATE_API_URL, { headers }),
          fetch(TEAMS_CONFIG_URL, { headers }),
          fetch(MY_TEAM_CONFIG_URL, { headers }),
          fetch(DRAFT_ORDER_CONFIG_URL, { headers }),
          fetch(ROSTER_POSITIONS_CONFIG_URL, { headers }),
        ])
        const [picksBody, teamsBody, myTeamBody, draftOrderBody, rosterBody] = await Promise.all([
          picksRes.json(),
          teamsRes.json(),
          myTeamRes.json(),
          draftOrderRes.json(),
          rosterRes.json(),
        ])
        if (!picksRes.ok) throw new Error(picksBody.error || `Request failed with status ${picksRes.status}`)
        if (!teamsRes.ok) throw new Error(teamsBody.error || `Request failed with status ${teamsRes.status}`)
        if (!myTeamRes.ok) throw new Error(myTeamBody.error || `Request failed with status ${myTeamRes.status}`)
        if (!draftOrderRes.ok) throw new Error(draftOrderBody.error || `Request failed with status ${draftOrderRes.status}`)
        if (!rosterRes.ok) throw new Error(rosterBody.error || `Request failed with status ${rosterRes.status}`)

        // Prefer the draft order's team_order for display (it's already the
        // league's canonical order) - fall back to the teams config if a
        // draft order hasn't been set yet.
        const order = draftOrderBody.team_order?.length ? draftOrderBody.team_order : (teamsBody.teams ?? [])

        setPicks(picksBody)
        setTeamOrder(order)
        setMyTeam(myTeamBody.team_name ?? null)
        setRosterPositions(rosterBody)
        setLoadStatus('ready')
      } catch (err) {
        setLoadStatus('error')
        setMessage(err.message)
      }
    })()
  }, [])

  return (
    <div className="draft-summary-page">
      <h2>Draft Summary</h2>

      {loadStatus === 'loading' && <p>Loading…</p>}
      {loadStatus === 'error' && <p className="draft-summary-status-error">{message}</p>}

      {loadStatus === 'ready' && (
        <div className="draft-summary-grid">
          {teamOrder.map((team) => {
            const slotFill = computeSlotFill(picks, team, rosterPositions)
            const isMyTeam = team === myTeam

            return (
              <div key={team} className={`draft-summary-card ${isMyTeam ? 'draft-summary-card-mine' : ''}`}>
                <h3>{team}{isMyTeam && ' (You)'}</h3>
                <table className="draft-summary-table">
                  <thead>
                    <tr>
                      <th>Slot</th>
                      <th>Filled</th>
                      <th>Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slotFill.map((s) => (
                      <tr key={s.slot_name} className={s.open === 0 ? 'draft-summary-row-full' : ''}>
                        <td>{s.slot_name}</td>
                        <td>{s.filled}/{s.count}</td>
                        <td>{s.open}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
