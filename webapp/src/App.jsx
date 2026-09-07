import { Authenticator } from '@aws-amplify/ui-react'
import '@aws-amplify/ui-react/styles.css'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useIsAdmin } from './auth/useAdmin'
import DraftBoardPage from './pages/DraftBoardPage'
import PipelinePage from './pages/PipelinePage'
import ConfigPage from './pages/ConfigPage'
import TrustDeviceBanner from './components/TrustDeviceBanner'
import Sidebar from './components/Sidebar'
import './App.css'

function PipelineRoute() {
  const isAdmin = useIsAdmin()

  if (isAdmin === null) return <p>Loading…</p>
  if (!isAdmin) return <Navigate to="/" replace />
  return <PipelinePage />
}

function ConfigRoute() {
  const isAdmin = useIsAdmin()

  if (isAdmin === null) return <p>Loading…</p>
  if (!isAdmin) return <Navigate to="/" replace />
  return <ConfigPage />
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
              <Route path="/pipeline" element={<PipelineRoute />} />
              <Route path="/config" element={<ConfigRoute />} />
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
