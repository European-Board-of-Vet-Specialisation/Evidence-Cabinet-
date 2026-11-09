-- What the decision screen needs from My College, sent in each review pass: what the claim
-- relates to, which adjustment types fit, the College's open examination diets and its own
-- adjustment codes. College configuration only; nothing about the candidate.
ALTER TABLE cases ADD COLUMN context TEXT;

-- The candidate's name as they give it on the upload page. The cabinet has no other way to
-- know who a case is about; deleted with the case.
ALTER TABLE cases ADD COLUMN candidate_name TEXT;
