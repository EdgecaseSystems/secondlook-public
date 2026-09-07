-- Additive migration for the structured request and observational review
-- contract. Legacy columns remain intact for backward compatibility.
ALTER TABLE decisions ADD COLUMN authority_json TEXT;
ALTER TABLE decisions ADD COLUMN hard_constraints_json TEXT;
ALTER TABLE decisions ADD COLUMN soft_preferences_json TEXT;
ALTER TABLE decisions ADD COLUMN known_facts_json TEXT;
ALTER TABLE decisions ADD COLUMN unknown_facts_json TEXT;
ALTER TABLE decisions ADD COLUMN alternatives_considered_json TEXT;
ALTER TABLE decisions ADD COLUMN review_status TEXT CHECK (
  review_status IS NULL OR review_status IN (
    'no_material_concern_found',
    'material_concern_found',
    'insufficient_information',
    'human_review_required'
  )
);

CREATE INDEX IF NOT EXISTS idx_decisions_review_status ON decisions(review_status);
