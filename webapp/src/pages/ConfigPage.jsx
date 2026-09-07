import { useEffect, useRef, useState } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import './ConfigPage.css'

// Same shared API as PipelinePage - see Lambda/Config/Config.py. One
// generic Lambda behind /config/{name}, so each named config just changes
// the URL, not the Lambda/route it hits.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const SCORING_API_URL = API_BASE_URL ? `${API_BASE_URL}/config/scoring` : null
const TEAMS_API_URL = API_BASE_URL ? `${API_BASE_URL}/config/teams` : null
const ROSTER_POSITIONS_API_URL = API_BASE_URL ? `${API_BASE_URL}/config/roster_positions` : null
const MY_TEAM_API_URL = API_BASE_URL ? `${API_BASE_URL}/config/my_team` : null
const DRAFT_ORDER_API_URL = API_BASE_URL ? `${API_BASE_URL}/config/draft_order` : null

async function authHeaders() {
  const session = await fetchAuthSession()
  const idToken = session.tokens?.idToken?.toString()
  return {
    'Content-Type': 'application/json',
    Authorization: idToken,
  }
}

function ScoringPanel({ initialCategories }) {
  const [categories, setCategories] = useState(initialCategories)
  const [saveStatus, setSaveStatus] = useState('ready') // ready | saving | success | error
  const [message, setMessage] = useState('')

  function updatePoints(index, points) {
    setCategories((prev) => prev.map((row, i) => (i === index ? { ...row, points } : row)))
  }

  function updateCategoryName(index, category) {
    setCategories((prev) => prev.map((row, i) => (i === index ? { ...row, category } : row)))
  }

  function removeRow(index) {
    setCategories((prev) => prev.filter((_, i) => i !== index))
  }

  function addRow() {
    setCategories((prev) => [...prev, { category: '', points: 0 }])
  }

  async function save() {
    if (!SCORING_API_URL) return

    setSaveStatus('saving')
    setMessage('')

    try {
      const cleaned = categories.map((row) => ({ category: row.category, points: Number(row.points) }))
      const res = await fetch(SCORING_API_URL, {
        method: 'PUT',
        headers: await authHeaders(),
        body: JSON.stringify({ categories: cleaned }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)

      setSaveStatus('success')
      setMessage(body.message || 'Scoring config saved.')
    } catch (err) {
      setSaveStatus('error')
      setMessage(err.message)
    }
  }

  return (
    <section className="config-panel">
      <h3>Scoring</h3>
      <p className="config-panel-description">
        Point value per scoring category. Editing this doesn't recompute
        anything by itself - re-run Gold from the Pipeline page afterward
        to apply it.
      </p>

      {categories.map((row, i) => (
        <div className="config-form-row" key={i}>
          <input
            type="text"
            placeholder="category"
            value={row.category}
            onChange={(e) => updateCategoryName(i, e.target.value)}
          />
          <input
            type="number"
            step="any"
            placeholder="points"
            value={row.points}
            onChange={(e) => updatePoints(i, e.target.value)}
          />
          <button type="button" onClick={() => removeRow(i)}>Remove</button>
        </div>
      ))}

      <button type="button" onClick={addRow}>Add Category</button>

      <div className="config-panel-actions">
        <button onClick={save} disabled={saveStatus === 'saving'}>
          {saveStatus === 'saving' ? 'Saving…' : 'Save Scoring Config'}
        </button>
      </div>

      {saveStatus === 'success' && <p className="config-status config-status-success">{message}</p>}
      {saveStatus === 'error' && <p className="config-status config-status-error">{message}</p>}
    </section>
  )
}

function TeamsPanel({ initialTeams }) {
  const [teams, setTeams] = useState(initialTeams)
  const [saveStatus, setSaveStatus] = useState('ready') // ready | saving | success | error
  const [message, setMessage] = useState('')

  function updateTeamName(index, name) {
    setTeams((prev) => prev.map((t, i) => (i === index ? name : t)))
  }

  function removeRow(index) {
    setTeams((prev) => prev.filter((_, i) => i !== index))
  }

  function addRow() {
    setTeams((prev) => [...prev, ''])
  }

  async function save() {
    if (!TEAMS_API_URL) return

    setSaveStatus('saving')
    setMessage('')

    try {
      const res = await fetch(TEAMS_API_URL, {
        method: 'PUT',
        headers: await authHeaders(),
        body: JSON.stringify({ teams }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)

      setSaveStatus('success')
      setMessage(body.message || 'Teams saved.')
    } catch (err) {
      setSaveStatus('error')
      setMessage(err.message)
    }
  }

  return (
    <section className="config-panel">
      <h3>Teams</h3>
      <p className="config-panel-description">
        League team names. League size is just however many teams are in
        this list - there's no separate count to keep in sync.
      </p>

      {teams.map((name, i) => (
        <div className="config-form-row" key={i}>
          <input
            type="text"
            placeholder="team name"
            value={name}
            onChange={(e) => updateTeamName(i, e.target.value)}
          />
          <button type="button" onClick={() => removeRow(i)}>Remove</button>
        </div>
      ))}

      <button type="button" onClick={addRow}>Add Team</button>

      <div className="config-panel-actions">
        <button onClick={save} disabled={saveStatus === 'saving'}>
          {saveStatus === 'saving' ? 'Saving…' : 'Save Teams'}
        </button>
      </div>

      {saveStatus === 'success' && <p className="config-status config-status-success">{message}</p>}
      {saveStatus === 'error' && <p className="config-status config-status-error">{message}</p>}
    </section>
  )
}

function MyTeamPanel({ teams, initialMyTeam }) {
  const [myTeam, setMyTeam] = useState(initialMyTeam)
  const [saveStatus, setSaveStatus] = useState('ready') // ready | saving | success | error
  const [message, setMessage] = useState('')

  async function save() {
    if (!MY_TEAM_API_URL) return

    setSaveStatus('saving')
    setMessage('')

    try {
      const res = await fetch(MY_TEAM_API_URL, {
        method: 'PUT',
        headers: await authHeaders(),
        body: JSON.stringify({ team_name: myTeam }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)

      setSaveStatus('success')
      setMessage(body.message || 'My team saved.')
    } catch (err) {
      setSaveStatus('error')
      setMessage(err.message)
    }
  }

  return (
    <section className="config-panel">
      <h3>My Team</h3>
      <p className="config-panel-description">
        Which team in the Teams list is yours - drives which roster the
        draft board tracks for positional need.
      </p>

      {teams.length === 0 ? (
        <p className="config-panel-description">Add teams under the Teams config first.</p>
      ) : (
        <div className="config-form-row">
          <label>
            Team
            <select value={myTeam} onChange={(e) => setMyTeam(e.target.value)}>
              <option value="" disabled>Select a team…</option>
              {teams.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="config-panel-actions">
        <button onClick={save} disabled={saveStatus === 'saving' || !myTeam}>
          {saveStatus === 'saving' ? 'Saving…' : 'Save My Team'}
        </button>
      </div>

      {saveStatus === 'success' && <p className="config-status config-status-success">{message}</p>}
      {saveStatus === 'error' && <p className="config-status config-status-error">{message}</p>}
    </section>
  )
}

function DraftOrderPanel({ initialDraftType, initialTeamOrder }) {
  const [draftType, setDraftType] = useState(initialDraftType)
  const [teamOrder, setTeamOrder] = useState(initialTeamOrder)
  const [saveStatus, setSaveStatus] = useState('ready') // ready | saving | success | error
  const [message, setMessage] = useState('')
  const dragIndex = useRef(null)

  function handleDragStart(index) {
    dragIndex.current = index
  }

  function handleDragOver(e) {
    e.preventDefault()
  }

  function handleDrop(index) {
    setTeamOrder((prev) => {
      const next = [...prev]
      const [moved] = next.splice(dragIndex.current, 1)
      next.splice(index, 0, moved)
      return next
    })
    dragIndex.current = null
  }

  async function save() {
    if (!DRAFT_ORDER_API_URL) return

    setSaveStatus('saving')
    setMessage('')

    try {
      const res = await fetch(DRAFT_ORDER_API_URL, {
        method: 'PUT',
        headers: await authHeaders(),
        body: JSON.stringify({ draft_type: draftType, team_order: teamOrder }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)

      setSaveStatus('success')
      setMessage(body.message || 'Draft order saved.')
    } catch (err) {
      setSaveStatus('error')
      setMessage(err.message)
    }
  }

  return (
    <section className="config-panel">
      <h3>Draft Order</h3>
      <p className="config-panel-description">
        Round-1 pick order, drag to reorder. Snake reverses the order each
        subsequent round; round robin repeats this same order every round.
      </p>

      {teamOrder.length === 0 ? (
        <p className="config-panel-description">Add teams under the Teams config first.</p>
      ) : (
        <>
          <div className="config-form-row">
            <label>
              Draft Type
              <select value={draftType} onChange={(e) => setDraftType(e.target.value)}>
                <option value="snake">Snake</option>
                <option value="round_robin">Round Robin</option>
              </select>
            </label>
          </div>

          <ol className="config-draft-order-list">
            {teamOrder.map((name, i) => (
              <li
                key={name}
                draggable
                onDragStart={() => handleDragStart(i)}
                onDragOver={handleDragOver}
                onDrop={() => handleDrop(i)}
              >
                <span className="config-drag-handle">⠿</span>
                {name}
              </li>
            ))}
          </ol>
        </>
      )}

      <div className="config-panel-actions">
        <button onClick={save} disabled={saveStatus === 'saving' || teamOrder.length === 0}>
          {saveStatus === 'saving' ? 'Saving…' : 'Save Draft Order'}
        </button>
      </div>

      {saveStatus === 'success' && <p className="config-status config-status-success">{message}</p>}
      {saveStatus === 'error' && <p className="config-status config-status-error">{message}</p>}
    </section>
  )
}

// FLEX/SUPERFLEX aren't special cases - they're just a slot whose
// eligible_positions list has more than one entry (e.g. FLEX ->
// "RB,WR,TE", SUPERFLEX -> "QB,RB,WR,TE"). Entered here as a plain
// comma-separated string and split/joined on save/load rather than a
// multi-select widget, to keep this simple for MVP1.
function RosterPositionsPanel({ initialSlots }) {
  const [slots, setSlots] = useState(initialSlots)
  const [saveStatus, setSaveStatus] = useState('ready') // ready | saving | success | error
  const [message, setMessage] = useState('')

  function updateSlot(index, field, value) {
    setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)))
  }

  function removeRow(index) {
    setSlots((prev) => prev.filter((_, i) => i !== index))
  }

  function addRow() {
    setSlots((prev) => [...prev, { slot_name: '', count: 1, eligible_positions: '' }])
  }

  async function save() {
    if (!ROSTER_POSITIONS_API_URL) return

    setSaveStatus('saving')
    setMessage('')

    try {
      const cleaned = slots.map((s) => ({
        slot_name: s.slot_name,
        count: Number(s.count),
        eligible_positions: s.eligible_positions
          .split(',')
          .map((p) => p.trim().toUpperCase())
          .filter(Boolean),
      }))
      const res = await fetch(ROSTER_POSITIONS_API_URL, {
        method: 'PUT',
        headers: await authHeaders(),
        body: JSON.stringify({ slots: cleaned }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)

      setSaveStatus('success')
      setMessage(body.message || 'Roster positions saved.')
    } catch (err) {
      setSaveStatus('error')
      setMessage(err.message)
    }
  }

  return (
    <section className="config-panel">
      <h3>Roster Positions</h3>
      <p className="config-panel-description">
        Roster slots and how many of each. FLEX/SUPERFLEX are just a slot
        with more than one eligible position - e.g. FLEX is "RB,WR,TE",
        SUPERFLEX is "QB,RB,WR,TE".
      </p>

      {slots.map((slot, i) => (
        <div className="config-form-row" key={i}>
          <input
            type="text"
            placeholder="slot name (e.g. FLEX)"
            value={slot.slot_name}
            onChange={(e) => updateSlot(i, 'slot_name', e.target.value)}
          />
          <input
            type="number"
            min="1"
            placeholder="count"
            value={slot.count}
            onChange={(e) => updateSlot(i, 'count', e.target.value)}
          />
          <input
            type="text"
            placeholder="eligible positions (e.g. RB,WR,TE)"
            value={slot.eligible_positions}
            onChange={(e) => updateSlot(i, 'eligible_positions', e.target.value)}
          />
          <button type="button" onClick={() => removeRow(i)}>Remove</button>
        </div>
      ))}

      <button type="button" onClick={addRow}>Add Slot</button>

      <div className="config-panel-actions">
        <button onClick={save} disabled={saveStatus === 'saving'}>
          {saveStatus === 'saving' ? 'Saving…' : 'Save Roster Positions'}
        </button>
      </div>

      {saveStatus === 'success' && <p className="config-status config-status-success">{message}</p>}
      {saveStatus === 'error' && <p className="config-status config-status-error">{message}</p>}
    </section>
  )
}

const TAB_KEYS = ['scoring', 'teams', 'my-team', 'draft-order', 'roster-positions']

export default function ConfigPage() {
  const [activeTab, setActiveTab] = useState(TAB_KEYS[0])
  const [loadStatus, setLoadStatus] = useState('loading') // loading | ready | error
  const [message, setMessage] = useState('')
  const [data, setData] = useState(null)

  // Everything loads once, here, on page mount - not per-tab - so
  // switching tabs is instant and doesn't re-fire a fetch. teams is
  // needed by both its own tab and My Team/Draft Order (for the
  // dropdown/reorder list), so it's fetched once and shared rather than
  // each panel fetching its own copy.
  useEffect(() => {
    ;(async () => {
      const urls = {
        scoring: SCORING_API_URL,
        teams: TEAMS_API_URL,
        myTeam: MY_TEAM_API_URL,
        draftOrder: DRAFT_ORDER_API_URL,
        rosterPositions: ROSTER_POSITIONS_API_URL,
      }

      if (Object.values(urls).some((url) => !url)) {
        setLoadStatus('error')
        setMessage('VITE_API_BASE_URL is not configured yet.')
        return
      }

      try {
        const headers = await authHeaders()
        const [scoringRes, teamsRes, myTeamRes, draftOrderRes, rosterPositionsRes] = await Promise.all([
          fetch(urls.scoring, { headers }),
          fetch(urls.teams, { headers }),
          fetch(urls.myTeam, { headers }),
          fetch(urls.draftOrder, { headers }),
          fetch(urls.rosterPositions, { headers }),
        ])
        const [scoringBody, teamsBody, myTeamBody, draftOrderBody, rosterPositionsBody] = await Promise.all([
          scoringRes.json(),
          teamsRes.json(),
          myTeamRes.json(),
          draftOrderRes.json(),
          rosterPositionsRes.json(),
        ])

        for (const [res, body] of [
          [scoringRes, scoringBody],
          [teamsRes, teamsBody],
          [myTeamRes, myTeamBody],
          [draftOrderRes, draftOrderBody],
          [rosterPositionsRes, rosterPositionsBody],
        ]) {
          if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)
        }

        const currentTeams = teamsBody.teams || []
        const savedOrder = draftOrderBody.team_order || []
        // Saved draft order might be stale (a team got added/removed/
        // renamed since it was last saved) - fall back to teams' own
        // order rather than showing something the backend would reject
        // on save anyway.
        const orderIsValid =
          savedOrder.length === currentTeams.length &&
          [...savedOrder].sort().join() === [...currentTeams].sort().join()

        setData({
          categories: scoringBody.categories || [],
          teams: currentTeams,
          myTeam: myTeamBody.team_name || '',
          draftType: draftOrderBody.draft_type || 'snake',
          teamOrder: orderIsValid ? savedOrder : currentTeams,
          slots: (rosterPositionsBody.slots || []).map((s) => ({
            slot_name: s.slot_name,
            count: s.count,
            eligible_positions: (s.eligible_positions || []).join(','),
          })),
        })
        setLoadStatus('ready')
      } catch (err) {
        setLoadStatus('error')
        setMessage(err.message)
      }
    })()
  }, [])

  return (
    <div className="config-page">
      <h2>Config</h2>

      <div className="config-tabs" role="tablist">
        {TAB_KEYS.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={activeTab === key}
            className={activeTab === key ? 'active' : ''}
            onClick={() => setActiveTab(key)}
          >
            {{
              scoring: 'Scoring',
              teams: 'Teams',
              'my-team': 'My Team',
              'draft-order': 'Draft Order',
              'roster-positions': 'Roster Positions',
            }[key]}
          </button>
        ))}
      </div>

      {loadStatus === 'loading' && <p>Loading…</p>}
      {loadStatus === 'error' && <p className="config-status config-status-error">{message}</p>}

      {loadStatus === 'ready' && (
        <>
          {activeTab === 'scoring' && <ScoringPanel initialCategories={data.categories} />}
          {activeTab === 'teams' && <TeamsPanel initialTeams={data.teams} />}
          {activeTab === 'my-team' && <MyTeamPanel teams={data.teams} initialMyTeam={data.myTeam} />}
          {activeTab === 'draft-order' && (
            <DraftOrderPanel
              initialDraftType={data.draftType}
              initialTeamOrder={data.teamOrder}
            />
          )}
          {activeTab === 'roster-positions' && <RosterPositionsPanel initialSlots={data.slots} />}
        </>
      )}
    </div>
  )
}
