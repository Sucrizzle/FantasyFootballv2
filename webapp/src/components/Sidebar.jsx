import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import './Sidebar.css'

const COLLAPSED_KEY = 'ffm.sidebarCollapsed'

export default function Sidebar({ isAdmin, user, signOut }) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === 'true'
    } catch {
      return false
    }
  })

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(COLLAPSED_KEY, String(next))
      } catch {
        // localStorage unavailable - collapse state just won't persist across reloads.
      }
      return next
    })
  }

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <div className="sidebar-top">
        <span className="sidebar-title">{collapsed ? 'FFM' : 'Fantasy Football Manager'}</span>
        <button className="sidebar-toggle" onClick={toggleCollapsed} aria-label="Toggle navigation">
          {collapsed ? '»' : '«'}
        </button>
      </div>

      <nav className="sidebar-nav">
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="sidebar-link-text">Draft Board</span>
        </NavLink>
        {isAdmin && (
          <NavLink to="/admin" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="sidebar-link-text">Admin</span>
          </NavLink>
        )}
      </nav>

      <div className="sidebar-bottom">
        <span className="sidebar-link-text">{user?.username}</span>
        <button onClick={signOut}>{collapsed ? '⏻' : 'Sign out'}</button>
      </div>
    </aside>
  )
}
