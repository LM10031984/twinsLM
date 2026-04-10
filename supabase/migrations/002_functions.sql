-- ============================================================
-- FONCTIONS DE RECHERCHE VECTORIELLE
-- ============================================================

-- Recherche sémantique dans le corpus identitaire de Laurens
create or replace function match_identity_corpus(
  query_embedding vector(1536),
  match_threshold float default 0.75,
  match_count int default 5,
  filter_source text default null
)
returns table(id uuid, content text, source text, similarity float)
language sql stable
as $$
  select
    id,
    content,
    source,
    1 - (embedding <=> query_embedding) as similarity
  from identity_corpus
  where
    (filter_source is null or source = filter_source)
    and 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;
