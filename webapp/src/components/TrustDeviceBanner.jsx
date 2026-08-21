import { useState } from 'react'
import { rememberDevice } from 'aws-amplify/auth'
import './TrustDeviceBanner.css'

// Only asks once per browser (tracked in localStorage), separate from
// Cognito's own device record - this flag just controls whether we've
// already shown the prompt, not whether the device is actually trusted.
const ASKED_KEY = 'ffm.trustDevicePrompted'

export default function TrustDeviceBanner() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(ASKED_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [error, setError] = useState('')

  function markAsked() {
    try {
      localStorage.setItem(ASKED_KEY, 'true')
    } catch {
      // localStorage unavailable (private browsing, etc.) - just don't persist the choice.
    }
    setDismissed(true)
  }

  async function trustDevice() {
    try {
      await rememberDevice()
      markAsked()
    } catch {
      setError('Could not trust this device. You can try again next time you sign in.')
    }
  }

  if (dismissed) return null

  return (
    <div className="trust-device-banner">
      <span>Skip MFA on this browser next time?</span>
      <div className="trust-device-actions">
        <button onClick={trustDevice}>Trust this device</button>
        <button className="trust-device-dismiss" onClick={markAsked}>Not now</button>
      </div>
      {error && <p className="trust-device-error">{error}</p>}
    </div>
  )
}
