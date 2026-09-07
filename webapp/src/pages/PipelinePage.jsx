import { useState } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import './PipelinePage.css'

// Mirrors nflreadpy's get_current_season(roster=True) / BronzeBackfill.py's
// validation cutoff - the season becomes "current" on March 15 (free
// agency/draft roster movement), not on Jan 1 or once the season itself
// completes. The current season IS selectable: draft prep needs rosters
// for the season that's about to be played, even though weekly_stats/pbp
// for it will come back sparse until games are actually played.
function getCurrentRosterSeason() {
  const now = new Date()
  const march15 = new Date(now.getFullYear(), 2, 15)
  return now >= march15 ? now.getFullYear() : now.getFullYear() - 1
}

const MOST_RECENT_SEASON = getCurrentRosterSeason()
// 15 seasons back from the current roster season.
const SEASON_OPTIONS = Array.from({ length: 15 }, (_, i) => MOST_RECENT_SEASON - i)

// Set VITE_API_BASE_URL in webapp/.env.local once the API Gateway is
// created - this is the shared API backing the whole app, not just this
// page, so routes are built on top of it rather than each page having its
// own base URL variable.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL
const BACKFILL_API_URL = API_BASE_URL ? `${API_BASE_URL}/pipeline/bronze-backfill` : null
const SILVER_API_URL = API_BASE_URL ? `${API_BASE_URL}/pipeline/silver` : null
const GOLD_API_URL = API_BASE_URL ? `${API_BASE_URL}/pipeline/gold` : null

export default function PipelinePage() {
  const [startSeason, setStartSeason] = useState(MOST_RECENT_SEASON - 11)
  const [endSeason, setEndSeason] = useState(MOST_RECENT_SEASON)
  const [status, setStatus] = useState('ready') // ready | running | success | error
  const [message, setMessage] = useState('')

  const [silverStatus, setSilverStatus] = useState('ready') // ready | running | success | error
  const [silverMessage, setSilverMessage] = useState('')

  const [goldStatus, setGoldStatus] = useState('ready') // ready | running | success | error
  const [goldMessage, setGoldMessage] = useState('')

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

  // Interim manual trigger while silver's design is still being sorted out
  // (rosters cleansing today, more sources later) - not part of the
  // eventual consolidated "Run Data Pipeline" flow yet.
  async function runSilver() {
    if (!SILVER_API_URL) {
      setSilverStatus('error')
      setSilverMessage('VITE_API_BASE_URL is not configured yet.')
      return
    }

    setSilverStatus('running')
    setSilverMessage('')

    try {
      const session = await fetchAuthSession()
      const idToken = session.tokens?.idToken?.toString()

      const res = await fetch(SILVER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: idToken,
        },
      })

      const body = await res.json()

      if (!res.ok) {
        throw new Error(body.error || `Request failed with status ${res.status}`)
      }

      setSilverStatus('success')
      setSilverMessage(body.message || 'Silver cleansing complete.')
    } catch (err) {
      setSilverStatus('error')
      setSilverMessage(err.message)
    }
  }

  // Interim manual trigger, same pattern as runSilver - runs gold's
  // manifest-driven queries against whatever's currently in silver. Will
  // eventually run automatically after a successful silver run instead of
  // needing its own button.
  async function runGold() {
    if (!GOLD_API_URL) {
      setGoldStatus('error')
      setGoldMessage('VITE_API_BASE_URL is not configured yet.')
      return
    }

    setGoldStatus('running')
    setGoldMessage('')

    try {
      const session = await fetchAuthSession()
      const idToken = session.tokens?.idToken?.toString()

      const res = await fetch(GOLD_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: idToken,
        },
      })

      const body = await res.json()

      if (!res.ok) {
        throw new Error(body.error || `Request failed with status ${res.status}`)
      }

      setGoldStatus('success')
      setGoldMessage(body.message || 'Gold run complete.')
    } catch (err) {
      setGoldStatus('error')
      setGoldMessage(err.message)
    }
  }

  return (
    <div className="pipeline-page">
      <h2>Pipeline</h2>

      <section className="pipeline-panel">
        <h3>Bronze Layer Backfill</h3>
        <p className="pipeline-panel-description">
          Pulls rosters, weekly stats, depth charts, draft picks, and injuries
          from nflreadpy and writes them to the S3 bronze layer. Every run
          purges existing data older than the current season before re-pulling.
        </p>

        <div className="pipeline-form-row">
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

        {status === 'success' && <p className="pipeline-status pipeline-status-success">{message}</p>}
        {status === 'error' && <p className="pipeline-status pipeline-status-error">{message}</p>}
      </section>

      <section className="pipeline-panel">
        <h3>Silver Layer Cleansing</h3>
        <p className="pipeline-panel-description">
          Interim manual trigger while silver's design is still being sorted
          out - runs rosters cleansing against whatever's currently in
          bronze. Will eventually run automatically after a successful
          backfill instead of needing its own button.
        </p>

        <button onClick={runSilver} disabled={silverStatus === 'running'}>
          {silverStatus === 'running' ? 'Running…' : 'Run Silver'}
        </button>

        {silverStatus === 'success' && <p className="pipeline-status pipeline-status-success">{silverMessage}</p>}
        {silverStatus === 'error' && <p className="pipeline-status pipeline-status-error">{silverMessage}</p>}
      </section>

      <section className="pipeline-panel">
        <h3>Gold Layer</h3>
        <p className="pipeline-panel-description">
          Interim manual trigger, same pattern as Silver - runs gold's
          manifest-driven queries (joins across silver sources, engineered
          features) against whatever's currently in silver. Will eventually
          run automatically after a successful silver run instead of
          needing its own button.
        </p>

        <button onClick={runGold} disabled={goldStatus === 'running'}>
          {goldStatus === 'running' ? 'Running…' : 'Run Gold'}
        </button>

        {goldStatus === 'success' && <p className="pipeline-status pipeline-status-success">{goldMessage}</p>}
        {goldStatus === 'error' && <p className="pipeline-status pipeline-status-error">{goldMessage}</p>}
      </section>
    </div>
  )
}
