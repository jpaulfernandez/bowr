-- A care label's facts replace a visual guess that landed first (fix found in the
-- P1.07 regression). The label result carries the field versions from when its job
-- was claimed. When the tags stage finished in between, the guess had bumped the
-- material's version, and the printed material was dropped as stale. A label may
-- now replace a field whose current value came from vision even at a newer
-- version. It still never replaces a locked value or anything a member edited.
-- Otherwise unchanged from P1.03.
create or replace function private.apply_suggestion(p_item public.items, p_source text, p_base jsonb, p_suggested jsonb)
returns text[]
language plpgsql
set search_path = ''
as $$
declare
  v_fields constant text[] := array['category', 'subcategory', 'pattern', 'material', 'formality', 'seasons',
    'style_tags', 'attributes', 'colors', 'brand', 'size_label'];
  v_field text;
  v_applied text[] := '{}';
  v_meta jsonb := p_item.field_meta;
  v_category text;
begin
  foreach v_field in array v_fields loop
    continue when not p_suggested ? v_field;
    continue when coalesce((v_meta -> v_field ->> 'locked')::boolean, false);
    continue when coalesce((v_meta -> v_field ->> 'v')::integer, 0) <> coalesce((p_base ->> v_field)::integer, -1)
      and not (p_source = 'label' and v_meta -> v_field ->> 'source' = 'vision');
    -- A value read from the care label is a printed fact; a visual guess never replaces it.
    continue when p_source = 'vision' and v_meta -> v_field ->> 'source' = 'label';
    v_applied := v_applied || v_field;
    v_meta := jsonb_set(v_meta, array[v_field], jsonb_build_object(
      'v', coalesce((v_meta -> v_field ->> 'v')::integer, 0) + 1, 'source', p_source, 'locked', false, 'at', now()));
  end loop;
  if cardinality(v_applied) = 0 then
    return v_applied;
  end if;

  v_category := case when 'category' = any (v_applied) then p_suggested ->> 'category' else p_item.category end;
  update public.items set
    category = v_category,
    subcategory = case
      when 'subcategory' = any (v_applied) and (private.taxonomy() -> 'categories' -> v_category) ? (p_suggested ->> 'subcategory')
        then p_suggested ->> 'subcategory'
      when v_category is not null and subcategory is not null and (private.taxonomy() -> 'categories' -> v_category) ? subcategory
        then subcategory
      else null end,
    pattern = case when 'pattern' = any (v_applied) then p_suggested ->> 'pattern' else pattern end,
    material = case when 'material' = any (v_applied) then p_suggested ->> 'material' else material end,
    brand = case when 'brand' = any (v_applied) then p_suggested ->> 'brand' else brand end,
    size_label = case when 'size_label' = any (v_applied) then p_suggested ->> 'size_label' else size_label end,
    formality = case when 'formality' = any (v_applied) then (p_suggested ->> 'formality')::smallint else formality end,
    seasons = case when 'seasons' = any (v_applied)
      then array(select e from jsonb_array_elements_text(p_suggested -> 'seasons') with ordinality t(e, o) group by e order by min(o))
      else seasons end,
    style_tags = case when 'style_tags' = any (v_applied)
      then array(select e from jsonb_array_elements_text(p_suggested -> 'style_tags') with ordinality t(e, o) group by e order by min(o))
      else style_tags end,
    attributes = case when 'attributes' = any (v_applied) then p_suggested -> 'attributes' else attributes end,
    colors = case when 'colors' = any (v_applied) then p_suggested -> 'colors' else colors end,
    category_review_required = case when 'category' = any (v_applied)
      then coalesce(p_suggested ->> 'category_confidence', 'low') <> 'high' else category_review_required end,
    field_meta = v_meta,
    revision = revision + 1,
    updated_at = now()
  where id = p_item.id;
  return v_applied;
end;
$$;
