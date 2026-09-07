// Shared by DraftBoardPage (my-team header summary) and DraftSummaryPage
// (every team) - a raw count of "how many RB has this team drafted" would
// ignore FLEX/BENCH fungibility (a 3rd RB can still fill FLEX or BENCH),
// so this actually assigns each drafted player to a roster slot instead.
//
// Greedy, most-specific-slot-first: a dedicated RB slot is filled before a
// FLEX slot, which is filled before BENCH (sorted by eligible_positions
// length - fewer eligible positions means more specific). This matches how
// a person fills out a roster by hand and avoids a 3rd RB "wasting" the
// dedicated RB slot's open count when it should count as a FLEX/BENCH fit
// instead.
export function computeSlotFill(picks, team, rosterPositions) {
  const slots = rosterPositions?.slots ?? []
  const teamPicks = picks.filter((p) => p.team === team)
  const assignedIndexes = new Set()

  const orderedSlots = [...slots].sort(
    (a, b) => a.eligible_positions.length - b.eligible_positions.length,
  )

  const filledBySlot = {}
  for (const slot of orderedSlots) {
    let filled = 0
    for (let i = 0; i < slot.count; i++) {
      const idx = teamPicks.findIndex(
        (p, j) => !assignedIndexes.has(j) && slot.eligible_positions.includes(p.pos),
      )
      if (idx === -1) break
      assignedIndexes.add(idx)
      filled += 1
    }
    filledBySlot[slot.slot_name] = filled
  }

  return slots.map((s) => ({
    slot_name: s.slot_name,
    count: s.count,
    filled: filledBySlot[s.slot_name] ?? 0,
    open: s.count - (filledBySlot[s.slot_name] ?? 0),
  }))
}
