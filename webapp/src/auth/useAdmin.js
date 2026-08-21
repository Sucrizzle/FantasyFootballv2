import { useEffect, useState } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'

// Reads the `cognito:groups` claim off the current ID token to determine
// whether the signed-in user is in the admin group. Cognito does not
// enforce group-based authorization itself - this is client-side gating
// only; the Lambda/API layer must independently check the same claim.
export function useIsAdmin() {
  const [isAdmin, setIsAdmin] = useState(null) // null = still loading

  useEffect(() => {
    let cancelled = false

    fetchAuthSession()
      .then((session) => {
        const groups = session.tokens?.idToken?.payload['cognito:groups'] ?? []
        if (!cancelled) setIsAdmin(groups.includes('admin'))
      })
      .catch(() => {
        if (!cancelled) setIsAdmin(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return isAdmin
}
