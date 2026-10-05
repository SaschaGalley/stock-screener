-- A review looks back on one decision — a purchase or a sale — and is shown
-- beside it. The decision's key is how the review page finds it again
-- (`Decision.key` in `analysis/review.ts`).
ALTER TABLE research_reports ADD COLUMN IF NOT EXISTS decision text;
CREATE INDEX IF NOT EXISTS research_reports_decision_idx ON research_reports (decision) WHERE decision IS NOT NULL;
