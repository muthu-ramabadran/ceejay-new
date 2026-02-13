-- Improve search evidence chips by returning matched query terms from searchable text.

CREATE OR REPLACE FUNCTION search_companies_hybrid_v1(
  p_query_text TEXT,
  p_query_embedding VECTOR(1536),
  p_statuses TEXT[] DEFAULT ARRAY['startup'],
  p_include_ids TEXT[] DEFAULT NULL,
  p_exclude_ids TEXT[] DEFAULT NULL,
  p_limit INT DEFAULT 120,
  p_min_semantic FLOAT DEFAULT 0.25
)
RETURNS TABLE (
  company_id TEXT,
  semantic_score FLOAT,
  keyword_score FLOAT,
  niche_score FLOAT,
  combined_score FLOAT,
  matched_fields TEXT[],
  matched_terms TEXT[]
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_query TEXT;
BEGIN
  v_query := trim(coalesce(p_query_text, ''));

  RETURN QUERY
  WITH base_companies AS (
    SELECT c.*
    FROM companies c
    WHERE
      (p_statuses IS NULL OR array_length(p_statuses, 1) IS NULL OR c.status = ANY(p_statuses))
      AND (p_include_ids IS NULL OR array_length(p_include_ids, 1) IS NULL OR c.id = ANY(p_include_ids))
      AND (p_exclude_ids IS NULL OR array_length(p_exclude_ids, 1) IS NULL OR NOT (c.id = ANY(p_exclude_ids)))
  ),
  query_terms AS (
    SELECT DISTINCT term
    FROM unnest(regexp_split_to_array(lower(v_query), '[^a-z0-9]+')) AS term
    WHERE length(term) >= 3
  ),
  semantic AS (
    SELECT
      ce.company_id::TEXT AS company_id,
      (1 - (ce.embedding <=> p_query_embedding))::FLOAT AS semantic_score
    FROM company_embeddings ce
    JOIN base_companies bc ON bc.id = ce.company_id
    WHERE ce.embedding_type = 'searchable_profile'
      AND (1 - (ce.embedding <=> p_query_embedding)) >= p_min_semantic
  ),
  keyword AS (
    SELECT
      bc.id::TEXT AS company_id,
      CASE
        WHEN v_query = '' THEN 0::FLOAT
        ELSE ts_rank(
          (
            setweight(to_tsvector('english', coalesce(bc.company_name, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(bc.tagline, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(bc.description, '')), 'B') ||
            setweight(to_tsvector('english', coalesce(bc.product_description, '')), 'B') ||
            setweight(to_tsvector('english', coalesce(bc.target_customer, '')), 'C') ||
            setweight(to_tsvector('english', coalesce(bc.problem_solved, '')), 'C') ||
            setweight(to_tsvector('english', coalesce(bc.differentiator, '')), 'C')
          ),
          websearch_to_tsquery('english', v_query)
        )::FLOAT
      END AS keyword_score
    FROM base_companies bc
  ),
  niche AS (
    SELECT
      bc.id::TEXT AS company_id,
      CASE
        WHEN v_query = '' THEN 0::FLOAT
        ELSE ts_rank(bc.niches_search, websearch_to_tsquery('english', v_query))::FLOAT
      END AS niche_score
    FROM base_companies bc
  ),
  merged AS (
    SELECT
      bc.id::TEXT AS company_id,
      coalesce(s.semantic_score, 0)::FLOAT AS semantic_score,
      coalesce(k.keyword_score, 0)::FLOAT AS keyword_score,
      coalesce(n.niche_score, 0)::FLOAT AS niche_score,
      lower(
        concat_ws(
          ' ',
          bc.company_name,
          bc.tagline,
          bc.description,
          bc.product_description,
          bc.target_customer,
          bc.problem_solved,
          bc.differentiator,
          array_to_string(coalesce(bc.niches, ARRAY[]::TEXT[]), ' ')
        )
      ) AS searchable_text
    FROM base_companies bc
    LEFT JOIN semantic s ON s.company_id = bc.id::TEXT
    LEFT JOIN keyword k ON k.company_id = bc.id::TEXT
    LEFT JOIN niche n ON n.company_id = bc.id::TEXT
  )
  SELECT
    m.company_id::TEXT,
    m.semantic_score::FLOAT,
    m.keyword_score::FLOAT,
    m.niche_score::FLOAT,
    (0.58 * m.semantic_score + 0.27 * m.keyword_score + 0.15 * m.niche_score)::FLOAT AS combined_score,
    ARRAY_REMOVE(ARRAY[
      CASE WHEN m.semantic_score > 0 THEN 'semantic' ELSE NULL END,
      CASE WHEN m.keyword_score > 0 THEN 'keyword' ELSE NULL END,
      CASE WHEN m.niche_score > 0 THEN 'niche' ELSE NULL END
    ], NULL)::TEXT[] AS matched_fields,
    coalesce(
      ARRAY(
        SELECT qt.term
        FROM query_terms qt
        WHERE m.searchable_text LIKE '%' || qt.term || '%'
        ORDER BY length(qt.term) DESC, qt.term
        LIMIT 8
      ),
      ARRAY[]::TEXT[]
    )::TEXT[] AS matched_terms
  FROM merged m
  WHERE (m.semantic_score > 0 OR m.keyword_score > 0 OR m.niche_score > 0)
  ORDER BY combined_score DESC, m.semantic_score DESC
  LIMIT greatest(1, p_limit);
END;
$$;

CREATE OR REPLACE FUNCTION search_companies_keyword_v1(
  p_query_text TEXT,
  p_statuses TEXT[] DEFAULT ARRAY['startup'],
  p_limit INT DEFAULT 120
)
RETURNS TABLE (
  company_id TEXT,
  keyword_score FLOAT,
  niche_score FLOAT,
  combined_score FLOAT,
  matched_terms TEXT[]
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_query TEXT;
BEGIN
  v_query := trim(coalesce(p_query_text, ''));
  IF v_query = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH base_companies AS (
    SELECT c.*
    FROM companies c
    WHERE (p_statuses IS NULL OR array_length(p_statuses, 1) IS NULL OR c.status = ANY(p_statuses))
  ),
  query_terms AS (
    SELECT DISTINCT term
    FROM unnest(regexp_split_to_array(lower(v_query), '[^a-z0-9]+')) AS term
    WHERE length(term) >= 3
  ),
  scored AS (
    SELECT
      bc.id::TEXT AS company_id,
      ts_rank(
        (
          setweight(to_tsvector('english', coalesce(bc.company_name, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(bc.tagline, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(bc.description, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(bc.product_description, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(bc.target_customer, '')), 'C') ||
          setweight(to_tsvector('english', coalesce(bc.problem_solved, '')), 'C') ||
          setweight(to_tsvector('english', coalesce(bc.differentiator, '')), 'C')
        ),
        websearch_to_tsquery('english', v_query)
      )::FLOAT AS keyword_score,
      ts_rank(bc.niches_search, websearch_to_tsquery('english', v_query))::FLOAT AS niche_score,
      lower(
        concat_ws(
          ' ',
          bc.company_name,
          bc.tagline,
          bc.description,
          bc.product_description,
          bc.target_customer,
          bc.problem_solved,
          bc.differentiator,
          array_to_string(coalesce(bc.niches, ARRAY[]::TEXT[]), ' ')
        )
      ) AS searchable_text
    FROM base_companies bc
  )
  SELECT
    s.company_id::TEXT,
    s.keyword_score::FLOAT,
    s.niche_score::FLOAT,
    (0.85 * s.keyword_score + 0.15 * s.niche_score)::FLOAT AS combined_score,
    coalesce(
      ARRAY(
        SELECT qt.term
        FROM query_terms qt
        WHERE s.searchable_text LIKE '%' || qt.term || '%'
        ORDER BY length(qt.term) DESC, qt.term
        LIMIT 8
      ),
      ARRAY[]::TEXT[]
    )::TEXT[] AS matched_terms
  FROM scored s
  WHERE (s.keyword_score > 0 OR s.niche_score > 0)
  ORDER BY combined_score DESC
  LIMIT greatest(1, p_limit);
END;
$$;
