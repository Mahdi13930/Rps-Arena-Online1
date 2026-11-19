CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  rating INTEGER NOT NULL DEFAULT 1000,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  matches INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_rating ON players(rating DESC, wins DESC);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code TEXT NOT NULL,
  player1_id TEXT NOT NULL,
  player2_id TEXT NOT NULL,
  player1_choice TEXT NOT NULL,
  player2_choice TEXT NOT NULL,
  winner_id TEXT,
  result TEXT NOT NULL,
  rating_change1 INTEGER NOT NULL,
  rating_change2 INTEGER NOT NULL,
  played_at TEXT NOT NULL,
  FOREIGN KEY(player1_id) REFERENCES players(id),
  FOREIGN KEY(player2_id) REFERENCES players(id)
);
CREATE INDEX IF NOT EXISTS idx_matches_played_at ON matches(played_at DESC);
