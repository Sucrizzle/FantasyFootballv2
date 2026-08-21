import { Authenticator } from '@aws-amplify/ui-react'
import '@aws-amplify/ui-react/styles.css'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useIsAdmin } from './auth/useAdmin'
import DraftBoardPage from './pages/DraftBoardPage'
import AdminPage from './pages/AdminPage'
import TrustDeviceBanner from './components/TrustDeviceBanner'
import Sidebar from './components/Sidebar'
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
      <div className="app-shell">
        <Sidebar isAdmin={isAdmin} user={user} signOut={signOut} />

        <div className="app-content">
          <TrustDeviceBanner />

          <main>
            <Routes>
              <Route path="/" element={<DraftBoardPage />} />
              <Route path="/admin" element={<AdminRoute />} />
            </Routes>
          </main>
        </div>
      </div>
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
