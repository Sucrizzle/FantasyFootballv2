import { useState } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import './AdminPage.css'

const CURRENT_YEAR = new Date().getFullYear()
const YEAR_OPTIONS = Array.from({ length: 15 }, (_, i) => CURRENT_YEAR - i)

// Set VITE_BACKFILL_API_URL in webapp/.env.local once the API Gateway
// route is created (see docs comment in BackfillLambda.py).
const BACKFILL_API_URL = import.meta.env.VITE_BACKFILL_API_URL

export default function AdminPage() {
  const [startYear, setStartYear] = useState(CURRENT_YEAR - 5)
  const [endYear, setEndYear] = useState(CURRENT_YEAR)
  const [purge, setPurge] = useState(false)
  const [status, setStatus] = useState('ready') // ready | running | success | error
  const [message, setMessage] = useState('')

  async function runBackfill() {
    if (!BACKFILL_API_URL) {
      setStatus('error')
      setMessage('VITE_BACKFILL_API_URL is not configured yet.')
      return
    }
    if (startYear > endYear) {
      setStatus('error')
      setMessage('Start year must be before end year.')
      return
    }

    setStatus('running')
    setMessage('')

    try {
      const session = await fetchAuthSession()
      const idToken = session.tokens?.idToken?.toString()

      const years = []
      for (let y = startYear; y <= endYear; y++) years.push(y)

      const res = await fetch(BACKFILL_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: idToken,
        },
        body: JSON.stringify({ years, purge }),
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
          from nflreadpy and writes them to the S3 bronze layer.
        </p>

        <div className="admin-form-row">
          <label>
            Start Year
            <select value={startYear} onChange={(e) => setStartYear(Number(e.target.value))}>
              {YEAR_OPTIONS.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>

          <label>
            End Year
            <select value={endYear} onChange={(e) => setEndYear(Number(e.target.value))}>
              {YEAR_OPTIONS.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
        </div>

        <label className="admin-checkbox-row">
          <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
          Purge existing partitions before re-pulling
        </label>

        <button onClick={runBackfill} disabled={status === 'running'}>
          {status === 'running' ? 'Running…' : 'Run Backfill'}
        </button>

        {status === 'success' && <p className="admin-status admin-status-success">{message}</p>}
        {status === 'error' && <p className="admin-status admin-status-error">{message}</p>}
      </section>
    </div>
  )
}
