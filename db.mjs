// @ts-check
import process from "node:process";
import pg from "pg";
import { loadDotEnv } from "./env.mjs";

export const ADMIN_BASE = "https://admin-console.propbulls.in";

// Re-exported so existing importers (migrate-old-data.mjs, preview-sync.mjs)
// keep working; the implementation moved to env.mjs so the watcher can load
// config without pulling in pg.
export { loadDotEnv };

export const SQL_PROJECTS = `
WITH accessibility_counts AS (
  SELECT project_id,
         (bool_or(feature_type = 'metro_station'))::int
       + (bool_or(feature_type = 'railway_station'))::int AS c
  FROM project_accessibility
  GROUP BY project_id
),
property_counts AS (
  -- c = active properties per project. The rera_*_c columns count how many of those
  -- active properties carry each RERA field, so the project query can treat a blank
  -- project-level RERA field as Present when EVERY active property supplies it.
  SELECT project_id,
         COUNT(*) AS c,
         COUNT(*) FILTER (WHERE NULLIF(BTRIM(rera_registration_no), '') IS NOT NULL) AS rera_num_c,
         COUNT(*) FILTER (WHERE rera_registration_date IS NOT NULL)                   AS rera_reg_c,
         COUNT(*) FILTER (WHERE rera_completion_date_first IS NOT NULL
                             OR rera_completion_date_last  IS NOT NULL)               AS rera_comp_c
  FROM property WHERE is_active = TRUE GROUP BY project_id
)
SELECT
  p.id                                                          AS project_id,
  p.name                                                        AS project_name,
  p.created_at                                                  AS created_at,
  u.name                                                        AS creator_name,
  CASE WHEN p.latitude IS NOT NULL AND p.longitude IS NOT NULL
        AND NULLIF(BTRIM(p.formatted_address), '') IS NOT NULL
       THEN 'Present' ELSE 'Missing' END                        AS location_status,
  CASE WHEN b.id IS NOT NULL THEN 'Present' ELSE 'Missing' END  AS builder_status,
  CASE WHEN p.land_type IS NOT NULL THEN 'Present' ELSE 'Missing' END AS land_type_status,
  CASE WHEN p.total_area_acres IS NOT NULL AND p.total_area_acres > 0
       THEN 'Present' ELSE 'Missing' END                        AS land_acres_status,
  CASE WHEN NULLIF(BTRIM(p.rera_number), '') IS NOT NULL
        OR (COALESCE(pc.c, 0) > 0 AND COALESCE(pc.rera_num_c, 0) = pc.c)
       THEN 'Present' ELSE 'Missing' END                        AS rera_number_status,
  -- Date rollups only apply to property-level-RERA projects (no project rera_number).
  -- If the project has its own rera_number, its dates must come from the project too.
  CASE WHEN p.rera_registration_date IS NOT NULL
        OR (NULLIF(BTRIM(p.rera_number), '') IS NULL
            AND COALESCE(pc.c, 0) > 0 AND COALESCE(pc.rera_reg_c, 0) = pc.c)
       THEN 'Present' ELSE 'Missing' END                        AS rera_registration_status,
  CASE WHEN p.rera_completion_date_first IS NOT NULL
        OR p.rera_completion_date_last IS NOT NULL
        OR (NULLIF(BTRIM(p.rera_number), '') IS NULL
            AND COALESCE(pc.c, 0) > 0 AND COALESCE(pc.rera_comp_c, 0) = pc.c)
       THEN 'Present' ELSE 'Missing' END                        AS rera_completion_status,
  COALESCE(ac.c, 0)                                             AS accessibility_count,
  COALESCE(pc.c, 0)                                             AS property_count,
  COALESCE(jsonb_array_length(p.images), 0)                     AS image_count,
  COALESCE(jsonb_array_length(p.attachments), 0)                AS attachment_count,
  COALESCE(jsonb_array_length(p.amenity_ids), 0)                AS amenity_count
FROM project p
LEFT JOIN "user"  u ON u.id = p.created_by_id
LEFT JOIN builder b ON b.id = p.builder_id AND b.is_active = TRUE
LEFT JOIN accessibility_counts ac ON ac.project_id = p.id
LEFT JOIN property_counts      pc ON pc.project_id = p.id
WHERE p.is_active = TRUE
  AND UPPER(BTRIM(p.country)) IN ('IN', 'INDIA')
  AND (
      (CASE WHEN p.latitude IS NOT NULL AND p.longitude IS NOT NULL
             AND NULLIF(BTRIM(p.formatted_address), '') IS NOT NULL THEN 0 ELSE 1 END)
    + (CASE WHEN b.id IS NOT NULL THEN 0 ELSE 1 END)
    + (CASE WHEN p.land_type IS NOT NULL THEN 0 ELSE 1 END)
    + (CASE WHEN p.total_area_acres IS NOT NULL AND p.total_area_acres > 0 THEN 0 ELSE 1 END)
    + (CASE WHEN NULLIF(BTRIM(p.rera_number), '') IS NOT NULL
             OR (COALESCE(pc.c, 0) > 0 AND COALESCE(pc.rera_num_c, 0) = pc.c) THEN 0 ELSE 1 END)
    + (CASE WHEN p.rera_registration_date IS NOT NULL
             OR (NULLIF(BTRIM(p.rera_number), '') IS NULL
                 AND COALESCE(pc.c, 0) > 0 AND COALESCE(pc.rera_reg_c, 0) = pc.c) THEN 0 ELSE 1 END)
    + (CASE WHEN p.rera_completion_date_first IS NOT NULL
             OR p.rera_completion_date_last IS NOT NULL
             OR (NULLIF(BTRIM(p.rera_number), '') IS NULL
                 AND COALESCE(pc.c, 0) > 0 AND COALESCE(pc.rera_comp_c, 0) = pc.c) THEN 0 ELSE 1 END)
    + (CASE WHEN COALESCE(ac.c, 0) < 2 THEN 1 ELSE 0 END)
    + (CASE WHEN COALESCE(pc.c, 0) < 1 THEN 1 ELSE 0 END)
    + (CASE WHEN COALESCE(jsonb_array_length(p.images), 0)      < 1 THEN 1 ELSE 0 END)
    + (CASE WHEN COALESCE(jsonb_array_length(p.attachments), 0) < 1 THEN 1 ELSE 0 END)
    + (CASE WHEN COALESCE(jsonb_array_length(p.amenity_ids), 0) < 1 THEN 1 ELSE 0 END)
  ) > 0
ORDER BY p.created_at DESC;
`;

export const SQL_PROPERTIES = `
WITH unit_counts AS (
  SELECT property_id, COUNT(*) AS c
  FROM unit_configuration WHERE is_active = TRUE GROUP BY property_id
)
SELECT
  prop.id          AS property_id,
  prop.project_id  AS project_id,
  proj.name        AS project_name,
  prop.name        AS property_name,
  prop.created_at  AS created_at,
  usr.name         AS creator_name,
  CASE WHEN prop.total_floors IS NOT NULL AND prop.total_floors > 0
       THEN 'Present' ELSE 'Missing' END AS total_floors_status,
  CASE WHEN prop.units_per_floor IS NOT NULL AND prop.units_per_floor > 0
       THEN 'Present' ELSE 'Missing' END AS units_per_floor_status,
  CASE WHEN COALESCE(uc.c, 0) > 0
       THEN 'Present' ELSE 'Missing' END AS unit_config_status
FROM property prop
INNER JOIN project proj ON proj.id = prop.project_id AND proj.is_active = TRUE
  AND UPPER(BTRIM(proj.country)) IN ('IN', 'INDIA')
LEFT JOIN "user" usr ON usr.id = prop.created_by_id
LEFT JOIN unit_counts uc ON uc.property_id = prop.id
WHERE prop.is_active = TRUE
  AND (
      (CASE WHEN prop.total_floors IS NOT NULL AND prop.total_floors > 0 THEN 0 ELSE 1 END)
    + (CASE WHEN prop.units_per_floor IS NOT NULL AND prop.units_per_floor > 0 THEN 0 ELSE 1 END)
    + (CASE WHEN COALESCE(uc.c, 0) > 0 THEN 0 ELSE 1 END)
  ) > 0
ORDER BY prop.created_at DESC;
`;

/** Sample rows for MOCK=1 smoke tests (no DB needed). */
export function mockData() {
  const projects = [
    {
      project_id: "3040fd6e-f0e2-492f-a6ae-6dacd25e56f0",
      project_name: "JVT (Jumeirah Village Triangle)",
      created_at: "2026-03-01T05:19:19Z",
      creator_name: "Viinit",
      location_status: "Missing", builder_status: "Missing", land_type_status: "Missing",
      land_acres_status: "Missing", rera_number_status: "Missing",
      rera_registration_status: "Missing", rera_completion_status: "Missing",
      accessibility_count: "1", property_count: "1", image_count: 0,
      attachment_count: 0, amenity_count: 0,
    },
    {
      project_id: "b74b9983-a801-4030-9519-9035fcb36260",
      project_name: 'Raman & Sons "Capital"',
      created_at: "2026-02-10T11:00:00Z",
      creator_name: "Anay Kanyalkar",
      location_status: "Present", builder_status: "Present", land_type_status: "Present",
      land_acres_status: "Present", rera_number_status: "Missing",
      rera_registration_status: "Present", rera_completion_status: "Present",
      accessibility_count: "2", property_count: "0", image_count: 3,
      attachment_count: 2, amenity_count: 6,
    },
  ];
  const properties = [
    {
      property_id: "ec15791d-1d95-46d3-8c34-ba6b2253e397",
      project_id: "5ffb8202-c2b6-448d-bc71-46d293bb7999",
      project_name: "PANORAMA", property_name: "Viewmont",
      created_at: "2026-06-09T13:10:14Z", creator_name: "Shreya Sharma",
      total_floors_status: "Missing",
      units_per_floor_status: "Missing", unit_config_status: "Missing",
    },
  ];
  return { projects, properties };
}

export async function fetchData() {
  loadDotEnv();
  if (process.env.MOCK === "1") return mockData();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL env var is required.");
    process.exit(1);
  }
  const isLocal = /@(localhost|127\.0\.0\.1)/.test(url);
  const client = new pg.Client({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const projects = (await client.query(SQL_PROJECTS)).rows;
    const properties = (await client.query(SQL_PROPERTIES)).rows;
    return { projects, properties };
  } finally {
    await client.end();
  }
}
