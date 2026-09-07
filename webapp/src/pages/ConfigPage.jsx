import { useEffect, useState } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import './ConfigPage.css'

// Same shared API as PipelinePage - see Lambda/Config/Config.py. One
// generic Lambda behind /config/{name}, so each named config just changes
// the URL, not the Lambda/route it hits.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const SCORING_API_URL = API_BASE_URL ? `${API_BASE_URL}/config/scoring` : null
const TEAMS_API_URL = API_BASE_URL ? `${API_BASE_URL}/config/teams` : null
const ROSTER_POSITIONS_API_URL = API_BASE_URL ? `${API_BASE_URL}/config/roster_positions` : null

async function authHeaders() {
  const session = await fetchAuthSession()
  const idToken = session.tokens?.idToken?.toString()
  return {
    'Content-Type': 'application/json',
    Authorization: idToken,
  }
}

function ScoringPanel() {
  const [categories, setCategories] = useState([])
  const [loadStatus, setLoadStatus] = useState('loading') // loading | ready | error
  const [saveStatus, setSaveStatus] = useState('ready') // ready | saving | success | error
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!SCORING_API_URL) {
      setLoadStatus('error')
      setMessage('VITE_API_BASE_URL is not configured yet.')
      return
    }

    ;(async () => {
      try {
        const res = await fetch(SCORING_API_URL, { headers: await authHeaders() })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)
        setCategories(body.categories || [])
        setLoadStatus('ready')
      } catch (err) {
        setLoadStatus('error')
        setMessage(err.message)
      }
    })()
  }, [])

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

  if (loadStatus === 'loading') return <p>Loading…</p>

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
      {(saveStatus === 'error' || loadStatus === 'error') && (
        <p className="config-status config-status-error">{message}</p>
      )}
    </section>
  )
}

function TeamsPanel() {
  const [teams, setTeams] = useState([])
  const [loadStatus, setLoadStatus] = useState('loading') // loading | ready | error
  const [saveStatus, setSaveStatus] = useState('ready') // ready | saving | success | error
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!TEAMS_API_URL) {
      setLoadStatus('error')
      setMessage('VITE_API_BASE_URL is not configured yet.')
      return
    }

    ;(async () => {
      try {
        const res = await fetch(TEAMS_API_URL, { headers: await authHeaders() })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)
        setTeams(body.teams || [])
        setLoadStatus('ready')
      } catch (err) {
        setLoadStatus('error')
        setMessage(err.message)
      }
    })()
  }, [])

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

  if (loadStatus === 'loading') return <p>Loading…</p>

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
      {(saveStatus === 'error' || loadStatus === 'error') && (
        <p className="config-status config-status-error">{message}</p>
      )}
    </section>
  )
}

// FLEX/SUPERFLEX aren't special cases - they're just a slot whose
// eligible_positions list has more than one entry (e.g. FLEX ->
// "RB,WR,TE", SUPERFLEX -> "QB,RB,WR,TE"). Entered here as a plain
// comma-separated string and split/joined on save/load rather than a
// multi-select widget, to keep this simple for MVP1.
function RosterPositionsPanel() {
  const [slots, setSlots] = useState([])
  const [loadStatus, setLoadStatus] = useState('loading') // loading | ready | error
  const [saveStatus, setSaveStatus] = useState('ready') // ready | saving | success | error
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!ROSTER_POSITIONS_API_URL) {
      setLoadStatus('error')
      setMessage('VITE_API_BASE_URL is not configured yet.')
      return
    }

    ;(async () => {
      try {
        const res = await fetch(ROSTER_POSITIONS_API_URL, { headers: await authHeaders() })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)
        const loaded = (body.slots || []).map((s) => ({
          slot_name: s.slot_name,
          count: s.count,
          eligible_positions: (s.eligible_positions || []).join(','),
        }))
        setSlots(loaded)
        setLoadStatus('ready')
      } catch (err) {
        setLoadStatus('error')
        setMessage(err.message)
      }
    })()
  }, [])

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

  if (loadStatus === 'loading') return <p>Loading…</p>

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
      {(saveStatus === 'error' || loadStatus === 'error') && (
        <p className="config-status config-status-error">{message}</p>
      )}
    </section>
  )
}

export default function ConfigPage() {
  return (
    <div className="config-page">
      <h2>Config</h2>
      <ScoringPanel />
      <TeamsPanel />
      <RosterPositionsPanel />
    </div>
  )
}
