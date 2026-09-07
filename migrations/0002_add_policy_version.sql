-- Existing decisions remain intact and have NULL policy_version, which denotes
-- the legacy pre-versioned policy. New decisions always persist their version.
ALTER TABLE decisions ADD COLUMN policy_version TEXT;
