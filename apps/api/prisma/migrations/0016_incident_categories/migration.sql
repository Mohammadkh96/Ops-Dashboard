-- Incident categories, and the tags joining them to incidents.
--
-- A table rather than an enum: the desk finds out what its categories are by
-- running the desk, and a fixed list written today is one somebody has to file
-- real incidents under wrongly next month.
CREATE TABLE "IncidentCategory" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "slug"      TEXT NOT NULL,
    "tone"      TEXT,
    "active"    BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentCategory_pkey" PRIMARY KEY ("id")
);

-- Uniqueness is on the slug, not the name: without it "PSP outage", "PSP
-- Outage" and "psp  outage" become three categories that mean one thing, and
-- every count computed over them is wrong.
CREATE UNIQUE INDEX "IncidentCategory_slug_key" ON "IncidentCategory"("slug");
CREATE INDEX "IncidentCategory_active_idx" ON "IncidentCategory"("active");

CREATE TABLE "IncidentCategoryOnIncident" (
    "incidentId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "taggedBy"   TEXT,
    "taggedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentCategoryOnIncident_pkey" PRIMARY KEY ("incidentId","categoryId")
);

CREATE INDEX "IncidentCategoryOnIncident_categoryId_idx" ON "IncidentCategoryOnIncident"("categoryId");

-- Cascade on both sides: a tag is meaningless without the two rows it joins,
-- and leaving orphans behind would show categories on incidents that no longer
-- exist.
ALTER TABLE "IncidentCategoryOnIncident"
  ADD CONSTRAINT "IncidentCategoryOnIncident_incidentId_fkey"
  FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IncidentCategoryOnIncident"
  ADD CONSTRAINT "IncidentCategoryOnIncident_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "IncidentCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
