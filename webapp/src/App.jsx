import { Authenticator } from '@aws-amplify/ui-react'
import '@aws-amplify/ui-react/styles.css'
import './App.css'

function App() {
  return (
    <Authenticator>
      {({ signOut, user }) => (
        <main>
          <h1>Fantasy Football Manager</h1>
          <p>Welcome, {user?.username}</p>
          <button onClick={signOut}>Sign out</button>
        </main>
      )}
    </Authenticator>
  )
}

export default App