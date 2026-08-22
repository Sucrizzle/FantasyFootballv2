import { useState } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import './AdminPage.css'

const CURRENT_YEAR = new Date().getFullYear()
const MOST_RECENT_SEASON = CURRENT_YEAR - 1
// 15 seasons back from the most recent completed one - the current year is
// never selectable since its season isn't complete yet.
const SEASON_OPTIONS = Array.from({ length: 15 }, (_, i) => MOST_RECENT_SEASON - i)

// Set VITE_API_BASE_URL in webapp/.env.local once the API Gateway is
// created - this is the shared API backing the whole app, not just this
// page, so routes are built on top of it rather than each page having its
// own base URL variable.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const BACKFILL_API_URL = API_BASE_URL ? `${API_BASE_URL}/admin/bronze-backfill` : null

export default function AdminPage() {
  const [startSeason, setStartSeason] = useState(MOST_RECENT_SEASON - 5)
  const [endSeason, setEndSeason] = useState(MOST_RECENT_SEASON)
  const [status, setStatus] = useState('ready') // ready | running | success | error
  const [message, setMessage] = useState('')

  async function runBackfill() {
    if (!BACKFILL_API_URL) {
      setStatus('error')
      setMessage('VITE_API_BASE_URL is not configured yet.')
      return
    }
    if (startSeason >= endSeason) {
      setStatus('error')
      setMessage('Start season must be before end season.')
      return
    }

    setStatus('running')
    setMessage('')

    try {
      const session = await fetchAuthSession()
      const idToken = session.tokens?.idToken?.toString()
      console.log('DEBUG ID TOKEN:', idToken) // TEMPORARY - remove after debugging admin claim

      const seasons = []
      for (let s = startSeason; s <= endSeason; s++) seasons.push(s)

      const res = await fetch(BACKFILL_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: idToken,
        },
        body: JSON.stringify({ seasons }),
      })

      const body = await res.json()

      if (!res.ok) {
        throw new Error(body.error || `Request failed with status ${res.status}`)
      }

      setStatus('success')
      setMessage(body.message || 'Backfill complete.')
    } catch (err) {
      setStatus('error')
      setMessage(err.message)
    }
  }

  return (
    <div className="admin-page">
      <h2>Admin</h2>

      <section className="admin-panel">
        <h3>Bronze Layer Backfill</h3>
        <p className="admin-panel-description">
          Pulls rosters, weekly stats, depth charts, draft picks, and injuries
          from nflreadpy and writes them to the S3 bronze layer. Every run
          purges existing data older than the current season before re-pulling.
        </p>

        <div className="admin-form-row">
          <label>
            Start Season
            <select value={startSeason} onChange={(e) => setStartSeason(Number(e.target.value))}>
              {SEASON_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>

          <label>
            End Season
            <select value={endSeason} onChange={(e) => setEndSeason(Number(e.target.value))}>
              {SEASON_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>

        <button onClick={runBackfill} disabled={status === 'running'}>
          {status === 'running' ? 'Running…' : 'Run Backfill'}
        </button>

        {status === 'success' && <p className="admin-status admin-status-success">{message}</p>}
        {status === 'error' && <p className="admin-status admin-status-error">{message}</p>}
      </section>
    </div>
  )
}
