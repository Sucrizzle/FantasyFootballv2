import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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

// Shared by every tab that uses explicit Save/Cancel (everything except
// Draft Setup, which auto-saves instead). Tracks a `saved` baseline
// alongside the live editable `value` - `hasChanges` is just whether they
// currently differ, `cancel` reverts to the baseline, and a successful
// save moves the baseline forward to what was just saved. Comparing via
// JSON.stringify is fine here since every value this wraps (arrays of
// plain objects/strings) round-trips through JSON as part of the PUT
// itself anyway - there's nothing in these shapes that comparison would
// get wrong (no Dates, functions, etc.).
function useSavablePanel(initialValue, onSave) {
  const [value, setValue] = useState(initialValue)
  const [saved, setSaved] = useState(initialValue)
  const [saveStatus, setSaveStatus] = useState('ready') // ready | saving | success | error
  const [message, setMessage] = useState('')

  const hasChanges = JSON.stringify(value) !== JSON.stringify(saved)

  async function save() {
    setSaveStatus('saving')
    setMessage('')

    try {
      const resultMessage = await onSave(value)
      setSaved(value)
      setSaveStatus('success')
      setMessage(resultMessage || 'Saved.')
    } catch (err) {
      setSaveStatus('error')
      setMessage(err.message)
    }
  }

  function cancel() {
    setValue(saved)
    setSaveStatus('ready')
    setMessage('')
  }

  return { value, setValue, hasChanges, saveStatus, message, save, cancel }
}

function SaveCancelActions({ hasChanges, saveStatus, message, onSave, onCancel }) {
  const disabled = !hasChanges || saveStatus === 'saving'
  return (
    <>
      <div className="config-panel-actions">
        <button onClick={onSave} disabled={disabled}>
          {saveStatus === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onCancel} disabled={disabled}>
          Cancel
        </button>
      </div>

      {saveStatus === 'success' && <p className="config-status config-status-success">{message}</p>}
      {saveStatus === 'error' && <p className="config-status config-status-error">{message}</p>}
    </>
  )
}

function ScoringPanel({ initialCategories }) {
  const { value: categories, setValue: setCategories, hasChanges, saveStatus, message, save, cancel } =
    useSavablePanel(initialCategories, async (categories) => {
      const cleaned = categories.map((row) => ({ category: row.category, points: Number(row.points) }))
      const res = await fetch(SCORING_API_URL, {
        method: 'PUT',
        headers: await authHeaders(),
        body: JSON.stringify({ categories: cleaned }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)
      return body.message
    })

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

      <SaveCancelActions hasChanges={hasChanges} saveStatus={saveStatus} message={message} onSave={save} onCancel={cancel} />
    </section>
  )
}

function TeamsPanel({ initialTeams }) {
  const { value: teams, setValue: setTeams, hasChanges, saveStatus, message, save, cancel } =
    useSavablePanel(initialTeams, async (teams) => {
      const res = await fetch(TEAMS_API_URL, {
        method: 'PUT',
        headers: await authHeaders(),
        body: JSON.stringify({ teams }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)
      return body.message
    })

  function updateTeamName(index, name) {
    setTeams((prev) => prev.map((t, i) => (i === index ? name : t)))
  }

  function removeRow(index) {
    setTeams((prev) => prev.filter((_, i) => i !== index))
  }

  function addRow() {
    setTeams((prev) => [...prev, ''])
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

      <SaveCancelActions hasChanges={hasChanges} saveStatus={saveStatus} message={message} onSave={save} onCancel={cancel} />
    </section>
  )
}

// Auto-saves myTeam ~600ms after it stops changing, skipping the very
// first render (that's just the initial fetched value, not an edit).
// Shared by both fields on this panel - each field gets its own instance
// with its own debounce timer, since they save to different config names.
function useAutoSave(value, { onSave, skip = false }) {
  const [status, setStatus] = useState('idle') // idle | saving | success | error
  const [message, setMessage] = useState('')
  const didMount = useRef(false)
  const onSaveRef = useRef(onSave)

  // Refs shouldn't be written during render - keep the ref pointed at the
  // latest onSave via its own effect (runs after every render) instead of
  // assigning it inline above.
  useEffect(() => {
    onSaveRef.current = onSave
  })

  // Keyed off a serialized value, not the raw reference - `value` can be
  // an array/object literal built fresh every render (e.g. [draftType,
  // teamOrder]), and effects compare dependencies by reference, so a new
  // literal each render would otherwise retrigger this on every
  // unrelated re-render, not just on real edits.
  const key = JSON.stringify(value)

  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true
      return
    }
    if (skip) return

    const timeout = setTimeout(async () => {
      setStatus('saving')
      try {
        const result = await onSaveRef.current()
        setStatus('success')
        setMessage(result || 'Saved.')
      } catch (err) {
        setStatus('error')
        setMessage(err.message)
      }
    }, 600)

    return () => clearTimeout(timeout)
  }, [key, skip])

  return { status, message }
}

function AutoSaveStatus({ save }) {
  if (save.status === 'saving') return <p className="config-status">Saving…</p>
  if (save.status === 'success') return <p className="config-status config-status-success">{save.message}</p>
  if (save.status === 'error') return <p className="config-status config-status-error">{save.message}</p>
  return null
}

function DraftSetupPanel({ teams, initialMyTeam, initialDraftType, initialTeamOrder }) {
  const [myTeam, setMyTeam] = useState(initialMyTeam)
  const [draftType, setDraftType] = useState(initialDraftType)
  const [teamOrder, setTeamOrder] = useState(initialTeamOrder)
  const [draggingName, setDraggingName] = useState(null)

  const myTeamSave = useAutoSave(myTeam, {
    skip: !myTeam,
    onSave: async () => {
      const res = await fetch(MY_TEAM_API_URL, {
        method: 'PUT',
        headers: await authHeaders(),
        body: JSON.stringify({ team_name: myTeam }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)
      return body.message
    },
  })

  const draftOrderSave = useAutoSave([draftType, teamOrder], {
    skip: teamOrder.length === 0,
    onSave: async () => {
      const res = await fetch(DRAFT_ORDER_API_URL, {
        method: 'PUT',
        headers: await authHeaders(),
        body: JSON.stringify({ draft_type: draftType, team_order: teamOrder }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Request failed with status ${res.status}`)
      return body.message
    },
  })

  // FLIP animation (First-Last-Invert-Play): measure each row's position
  // before a reorder, let React re-render in the new order, then animate
  // from the old position to the new one. Measuring actual rendered
  // positions (rather than assuming a fixed row height) means this stays
  // correct regardless of font size/theme/content changes.
  const itemRefs = useRef({}) // team name -> DOM node
  const prevTops = useRef({}) // team name -> last measured top, for the animation below

  function capturePositions() {
    const positions = {}
    for (const name in itemRefs.current) {
      const node = itemRefs.current[name]
      if (node) positions[name] = node.getBoundingClientRect().top
    }
    return positions
  }

  useLayoutEffect(() => {
    const newTops = capturePositions()
    for (const name in newTops) {
      const prevTop = prevTops.current[name]
      const newTop = newTops[name]
      const node = itemRefs.current[name]
      if (node && prevTop != null && prevTop !== newTop) {
        // Jump it back to where it visually was (no transition), then let
        // the browser paint that, then animate to the real position - the
        // classic FLIP "invert, then play" step.
        node.style.transition = 'none'
        node.style.transform = `translateY(${prevTop - newTop}px)`
        requestAnimationFrame(() => {
          node.style.transition = 'transform 150ms ease'
          node.style.transform = ''
        })
      }
    }
    prevTops.current = newTops
  }, [teamOrder])

  // Reorders live, on every drag-over of a different team, rather than
  // only on drop - that's what makes the other rows visibly slide out of
  // the way while dragging instead of just snapping at the end. The
  // auto-save debounce means this only actually PUTs ~600ms after you
  // stop dragging, not on every intermediate reorder.
  function handleDragOver(e, overName) {
    e.preventDefault()
    if (overName === draggingName) return

    prevTops.current = capturePositions()
    setTeamOrder((prev) => {
      const from = prev.indexOf(draggingName)
      const to = prev.indexOf(overName)
      if (from === -1 || to === -1 || from === to) return prev
      const next = [...prev]
      next.splice(from, 1)
      next.splice(to, 0, draggingName)
      return next
    })
  }

  return (
    <>
      <section className="config-panel">
        <h3>My Team</h3>
        <p className="config-panel-description">
          Which team in the Teams list is yours - drives which roster the
          draft board tracks for positional need. Saves automatically.
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

        <AutoSaveStatus save={myTeamSave} />
      </section>

      <section className="config-panel">
        <h3>Draft Order</h3>
        <p className="config-panel-description">
          Round-1 pick order, drag to reorder. Snake reverses the order each
          subsequent round; round robin repeats this same order every round.
          Saves automatically.
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
                  ref={(el) => { itemRefs.current[name] = el }}
                  draggable
                  className={draggingName === name ? 'dragging' : ''}
                  onDragStart={() => setDraggingName(name)}
                  onDragOver={(e) => handleDragOver(e, name)}
                  onDragEnd={() => setDraggingName(null)}
                >
                  <span className="config-drag-handle">⠿</span>
                  <span className="config-draft-position">{i + 1}.</span>
                  {name}
                </li>
              ))}
            </ol>
          </>
        )}

        <AutoSaveStatus save={draftOrderSave} />
      </section>
    </>
  )
}

// FLEX/SUPERFLEX aren't special cases - they're just a slot whose
// eligible_positions list has more than one entry (e.g. FLEX ->
// "RB,WR,TE", SUPERFLEX -> "QB,RB,WR,TE"). Entered here as a plain
// comma-separated string and split/joined on save/load rather than a
// multi-select widget, to keep this simple for MVP1.
function RosterPositionsPanel({ initialSlots }) {
  const { value: slots, setValue: setSlots, hasChanges, saveStatus, message, save, cancel } =
    useSavablePanel(initialSlots, async (slots) => {
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
      return body.message
    })

  function updateSlot(index, field, value) {
    setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)))
  }

  function removeRow(index) {
    setSlots((prev) => prev.filter((_, i) => i !== index))
  }

  function addRow() {
    setSlots((prev) => [...prev, { slot_name: '', count: 1, eligible_positions: '' }])
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

      <SaveCancelActions hasChanges={hasChanges} saveStatus={saveStatus} message={message} onSave={save} onCancel={cancel} />
    </section>
  )
}

const TAB_KEYS = ['scoring', 'teams', 'draft-setup', 'roster-positions']

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
              'draft-setup': 'Draft Setup',
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
          {activeTab === 'draft-setup' && (
            <DraftSetupPanel
              teams={data.teams}
              initialMyTeam={data.myTeam}
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
