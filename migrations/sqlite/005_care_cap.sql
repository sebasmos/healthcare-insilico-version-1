-- Time machine: a practice copy can be cut at a moment in the patient's care (clinical time), not only at a
-- moment of recording. Rows from the parents whose clinical time is after the cut are hidden on that copy.
ALTER TABLE branches ADD COLUMN care_cap TEXT;
