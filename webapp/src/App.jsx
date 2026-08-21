import { Authenticator } from '@aws-amplify/ui-react'
import '@aws-amplify/ui-react/styles.css'
import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom'
import { useIsAdmin } from './auth/useAdmin'
import DraftBoardPage from './pages/DraftBoardPage'
import AdminPage from './pages/AdminPage'
import './App.css'

function AdminRoute() {
  const isAdmin = useIsAdmin()

  if (isAdmin === null) return <p>Loading…</p>
  if (!isAdmin) return <Navigate to="/" replace />
  return <AdminPage />
}

function AppShell({ signOut, user }) {
  const isAdmin = useIsAdmin()

  return (
    <BrowserRouter>
      <header className="app-header">
        <h1>Fantasy Football Manager</h1>
        <nav>
          <Link to="/">Draft Board</Link>
          {isAdmin && <Link to="/admin">Admin</Link>}
        </nav>
        <div className="app-header-user">
          <span>{user?.username}</span>
          <button onClick={signOut}>Sign out</button>
        </div>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<DraftBoardPage />} />
          <Route path="/admin" element={<AdminRoute />} />
        </Routes>
      </main>
    </BrowserRouter>
  )
}

function App() {
  return (
    <Authenticator>
      {({ signOut, user }) => <AppShell signOut={signOut} user={user} />}
    </Authenticator>
  )
}

export default App
