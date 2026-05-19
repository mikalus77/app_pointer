create or replace function public.rpc_pointage_validate_day(
  p_user_id integer,
  p_pointage_date date
)
returns integer
language plpgsql
security definer
as $$
declare
  v_en_cours_status_id integer;
  v_termine_status_id integer;
  v_active_session_count integer;
  v_updated_count integer;
begin
  perform pg_advisory_xact_lock(71002, p_user_id);

  select sp.id_statut_pointage
  into v_en_cours_status_id
  from public.statut_pointage sp
  where sp.code_statut_pointage = 'EN_COURS'
    and sp.actif = true
  limit 1;

  if v_en_cours_status_id is null then
    raise exception 'Missing EN_COURS status in statut_pointage';
  end if;

  select sp.id_statut_pointage
  into v_termine_status_id
  from public.statut_pointage sp
  where sp.code_statut_pointage = 'TERMINE'
    and sp.actif = true
  limit 1;

  if v_termine_status_id is null then
    raise exception 'Missing TERMINE status in statut_pointage';
  end if;

  select count(*)
  into v_active_session_count
  from public.session_pointage sess
  join public.pointage p on p.id_pointage = sess.id_pointage
  where p.id_utilisateur_pointeur = p_user_id
    and p.date_pointage = p_pointage_date
    and p.id_statut_pointage = v_en_cours_status_id
    and sess.fin_session_pointage is null;

  if v_active_session_count > 0 then
    raise exception 'Cannot validate pointage while a session is active';
  end if;

  update public.pointage p
  set id_statut_pointage = v_termine_status_id
  where p.id_utilisateur_pointeur = p_user_id
    and p.date_pointage = p_pointage_date
    and p.id_statut_pointage = v_en_cours_status_id;

  get diagnostics v_updated_count = row_count;

  return coalesce(v_updated_count, 0);
end;
$$;
