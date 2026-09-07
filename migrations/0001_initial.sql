CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  agent_id_hash TEXT,
  goal_redacted TEXT NOT NULL,
  proposed_action_redacted TEXT NOT NULL,
  reasoning_redacted TEXT,
  constraints_json TEXT NOT NULL,
  uncertainties_json TEXT NOT NULL,
  recommendation TEXT NOT NULL CHECK (recommendation IN ('proceed','reconsider','need_more_information','escalate_to_human')),
  reason TEXT NOT NULL,
  key_risks_json TEXT NOT NULL,
  missing_information_json TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER
);

CREATE TABLE IF NOT EXISTS outcomes (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reporter_agent_id_hash TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('successful','unsuccessful','human_approved','human_corrected','reversed','no_observable_issue','unknown')),
  details_redacted TEXT,
  measurable_value REAL,
  currency TEXT,
  FOREIGN KEY (decision_id) REFERENCES decisions(id)
);

CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_recommendation ON decisions(recommendation);
CREATE INDEX IF NOT EXISTS idx_outcomes_decision_id ON outcomes(decision_id);
