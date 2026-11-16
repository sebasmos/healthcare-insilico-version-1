-- Research data model (plan-master task 5): Study, StudyLink, Review, Correction, Redaction and DatasetSnapshot
-- live in resource_versions like every other internal type. These expression indexes cover their lookups
-- by study, target and creation time.
CREATE INDEX idx_rv_research_study ON resource_versions (resource_type, json_extract(body, '$.study'))
  WHERE resource_type IN ('StudyLink', 'DatasetSnapshot');
CREATE INDEX idx_rv_research_target ON resource_versions (resource_type, json_extract(body, '$.target'))
  WHERE resource_type IN ('Review', 'Correction', 'Redaction');
CREATE INDEX idx_rv_research_created ON resource_versions (resource_type, json_extract(body, '$.createdAt'))
  WHERE resource_type IN ('Study', 'StudyLink', 'Review', 'Correction', 'Redaction', 'DatasetSnapshot');
