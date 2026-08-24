BEGIN;

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

ALTER TABLE gateways ADD COLUMN IF NOT EXISTS custom_name text NOT NULL DEFAULT '';
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS gateway_number integer;

ALTER TABLE hangers ADD COLUMN IF NOT EXISTS custom_name text NOT NULL DEFAULT '';
ALTER TABLE hangers ADD COLUMN IF NOT EXISTS hanger_number integer;

ALTER TABLE garments ADD COLUMN IF NOT EXISTS original_image_path text NOT NULL DEFAULT '';
ALTER TABLE garments ADD COLUMN IF NOT EXISTS processed_image_path text NOT NULL DEFAULT '';
ALTER TABLE garments ADD COLUMN IF NOT EXISTS image_processing_status text NOT NULL DEFAULT 'ready';
ALTER TABLE garments ADD COLUMN IF NOT EXISTS classification jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE garments ADD COLUMN IF NOT EXISTS classification_confidence jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE garments ADD COLUMN IF NOT EXISTS processing_error text NOT NULL DEFAULT '';

UPDATE app_users
SET role = 'user'
WHERE role IS NULL
   OR btrim(role) = '';

UPDATE gateways
SET custom_name = name
WHERE coalesce(btrim(custom_name), '') = ''
  AND coalesce(btrim(name), '') <> ''
  AND name <> '새 옷봉';

UPDATE hangers
SET custom_name = alias
WHERE coalesce(btrim(custom_name), '') = ''
  AND coalesce(btrim(alias), '') <> '';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gateways
    WHERE wardrobe_id IS NOT NULL
      AND gateway_number IS NOT NULL
    GROUP BY wardrobe_id, gateway_number
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'gateway_number collision detected';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM hangers
    WHERE gateway_id IS NOT NULL
      AND hanger_number IS NOT NULL
    GROUP BY gateway_id, hanger_number
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'hanger_number collision detected';
  END IF;
END
$$;

WITH existing_max AS (
  SELECT
    wardrobe_id,
    coalesce(max(gateway_number), 0) AS max_number
  FROM gateways
  WHERE wardrobe_id IS NOT NULL
  GROUP BY wardrobe_id
),
unnumbered AS (
  SELECT
    g.gateway_id,
    (
      em.max_number +
      row_number() OVER (
        PARTITION BY g.wardrobe_id
        ORDER BY g.created_at ASC NULLS LAST, g.gateway_id ASC
      )
    )::integer AS assigned_number
  FROM gateways AS g
  JOIN existing_max AS em
    ON em.wardrobe_id = g.wardrobe_id
  WHERE g.wardrobe_id IS NOT NULL
    AND g.gateway_number IS NULL
)
UPDATE gateways AS g
SET gateway_number = u.assigned_number
FROM unnumbered AS u
WHERE g.gateway_id = u.gateway_id;

WITH existing_max AS (
  SELECT
    gateway_id,
    coalesce(max(hanger_number), 0) AS max_number
  FROM hangers
  WHERE gateway_id IS NOT NULL
  GROUP BY gateway_id
),
unnumbered AS (
  SELECT
    h.hanger_id,
    (
      em.max_number +
      row_number() OVER (
        PARTITION BY h.gateway_id
        ORDER BY h.created_at ASC NULLS LAST, h.hanger_id ASC
      )
    )::integer AS assigned_number
  FROM hangers AS h
  JOIN existing_max AS em
    ON em.gateway_id = h.gateway_id
  WHERE h.gateway_id IS NOT NULL
    AND h.hanger_number IS NULL
)
UPDATE hangers AS h
SET hanger_number = u.assigned_number
FROM unnumbered AS u
WHERE h.hanger_id = u.hanger_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM gateways
    WHERE wardrobe_id IS NOT NULL
      AND gateway_number IS NOT NULL
    GROUP BY wardrobe_id, gateway_number
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'gateway_number collision after backfill';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM hangers
    WHERE gateway_id IS NOT NULL
      AND hanger_number IS NOT NULL
    GROUP BY gateway_id, hanger_number
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'hanger_number collision after backfill';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS gateways_wardrobe_number_unique
  ON gateways (wardrobe_id, gateway_number)
  WHERE wardrobe_id IS NOT NULL
    AND gateway_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS hangers_gateway_number_unique
  ON hangers (gateway_id, hanger_number)
  WHERE gateway_id IS NOT NULL
    AND hanger_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS gateways_wardrobe_idx
  ON gateways (wardrobe_id);

CREATE INDEX IF NOT EXISTS hangers_gateway_idx
  ON hangers (gateway_id);

CREATE INDEX IF NOT EXISTS hangers_wardrobe_idx
  ON hangers (wardrobe_id);

CREATE INDEX IF NOT EXISTS garments_wardrobe_idx
  ON garments (wardrobe_id);

COMMIT;
