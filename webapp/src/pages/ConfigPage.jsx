import { useEffect, useState } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import './ConfigPage.css'

// Same shared API as PipelinePage - see Lambda/Config/Config.py. One
// generic Lambda behind /config/{name}, so each named config just changes
// the URL, not the Lambda/route it hits.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const SCORING_API_URL = API_BASE_URL ? `${API_BASE_URL}/config/scoring` : null
const TEAM_SIZE_API_URL = API_BASE_URL ? `${API_BASE_URL}/config/team_size` : null

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

function TeamSizePanel() {
  const [teamCount, setTeamCount] = useState(12)
  const [loadStatus, setLoadStatus] = useState('loading') // loading | ready | error
  const [saveStatus, setSaveStatus] = useState('ready') // ready | saving | success | error
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!TEAM_SIZE_API_URL) {
      setLoadStatus('error')
      setMessage('VITE_API_BASE_URL is not configured yet.')
      return
    }

    ;(async () => {
      try {
        const res = await fetch(TEAM_SIZE_API_URL, { headers: await authHeaders() })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)
        setTeamCount(body.team_count ?? 12)
        setLoadStatus('ready')
      } catch (err) {
        setLoadStatus('error')
        setMessage(err.message)
      }
    })()
  }, [])

  async function save() {
    if (!TEAM_SIZE_API_URL) return

    setSaveStatus('saving')
    setMessage('')

    try {
      const res = await fetch(TEAM_SIZE_API_URL, {
        method: 'PUT',
        headers: await authHeaders(),
        body: JSON.stringify({ team_count: Number(teamCount) }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)

      setSaveStatus('success')
      setMessage(body.message || 'Team size saved.')
    } catch (err) {
      setSaveStatus('error')
      setMessage(err.message)
    }
  }

  if (loadStatus === 'loading') return <p>Loading…</p>

  return (
    <section className="config-panel">
      <h3>Team Size</h3>
      <p className="config-panel-description">Number of teams in the league.</p>

      <div className="config-form-row">
        <label>
          Team Count
          <input
            type="number"
            min="2"
            max="32"
            value={teamCount}
            onChange={(e) => setTeamCount(e.target.value)}
          />
        </label>
      </div>

      <div className="config-panel-actions">
        <button onClick={save} disabled={saveStatus === 'saving'}>
          {saveStatus === 'saving' ? 'Saving…' : 'Save Team Size'}
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
      <TeamSizePanel />
    </div>
  )
}
