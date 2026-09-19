// Role assignment per CLAUDE.md §7.
// mafia = max(1, floor(n/4)); doctor at n>=5; detective at n>=6; rest villager.

export const MIN_PLAYERS = 4;

export function roleCounts(n) {
  return {
    mafia: Math.max(1, Math.floor(n / 4)),
    doctor: n >= 5 ? 1 : 0,
    detective: n >= 6 ? 1 : 0,
  };
}

function shuffle(items, rng = Math.random) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// players: [{ phone, name }] -> [{ phone, name, seat, role }]
// `rng` is injectable (defaults to Math.random) so the simulator can replay
// a failing seed exactly per CLAUDE.md §9.
export function assignRoles(players, rng = Math.random) {
  if (players.length < MIN_PLAYERS) {
    throw new Error(
      `need at least ${MIN_PLAYERS} players, got ${players.length}`,
    );
  }

  const { mafia, doctor, detective } = roleCounts(players.length);
  const roles = [
    ...Array(mafia).fill("mafia"),
    ...Array(doctor).fill("doctor"),
    ...Array(detective).fill("detective"),
  ];
  while (roles.length < players.length) roles.push("villager");

  const shuffledRoles = shuffle(roles, rng);
  return players.map((player, i) => ({
    ...player,
    seat: i + 1,
    role: shuffledRoles[i],
    alive: true,
  }));
}
