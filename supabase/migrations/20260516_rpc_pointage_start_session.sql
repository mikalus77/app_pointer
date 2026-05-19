create or replace function public.rpc_pointage_start_session(
  p_user_id integer,
  p_task_id integer,
  p_pointage_date date
)
returns table (
  id_pointage integer,
  id_session_pointage integer,
  debut_session_pointage timestamp with time zone,
  existing_active boolean
)
language plpgsql
security definer
as $$
declare
  v_status_id integer;
  v_existing_pointage_id integer;
  v_existing_session_id integer;
  v_existing_session_start timestamp with time zone;
  v_pointage_id integer;
  v_session_id integer;
  v_session_start timestamp with time zone;
begin
  perform pg_advisory_xact_lock(71002, p_user_id);

  select s.id_session_pointage, s.id_pointage, s.debut_session_pointage
  into v_existing_session_id, v_existing_pointage_id, v_existing_session_start
  from public.session_pointage s
  join public.pointage p on p.id_pointage = s.id_pointage
  where p.id_utilisateur_pointeur = p_user_id
    and s.fin_session_pointage is null
  order by s.debut_session_pointage desc
  limit 1;

  if v_existing_session_id is not null then
    return query
      select
        v_existing_pointage_id,
        v_existing_session_id,
        v_existing_session_start,
        true;
    return;
  end if;

  select p.id_pointage
  into v_pointage_id
  from public.pointage p
  where p.id_utilisateur_pointeur = p_user_id
    and p.id_tache = p_task_id
    and p.date_pointage = p_pointage_date
  order by p.id_pointage asc
  limit 1;

  if v_pointage_id is null then
    select sp.id_statut_pointage
    into v_status_id
    from public.statut_pointage sp
    where sp.code_statut_pointage = 'EN_COURS'
      and sp.actif = true
    limit 1;

    if v_status_id is null then
      raise exception 'Missing EN_COURS status in statut_pointage';
    end if;

    insert into public.pointage (
      id_utilisateur_pointeur,
      id_utilisateur_traitement,
      id_tache,
      id_statut_pointage,
      date_pointage,
      date_traitement_pointage,
      remarque_admin_pointage
    ) values (
      p_user_id,
      null,
      p_task_id,
      v_status_id,
      p_pointage_date,
      null,
      null
    )
    returning id_pointage into v_pointage_id;
  end if;

  insert into public.session_pointage (
    id_pointage,
    fin_session_pointage,
    commentaire_session_pointage
  ) values (
    v_pointage_id,
    null,
    null
  )
  returning id_session_pointage, debut_session_pointage
  into v_session_id, v_session_start;

  return query
    select
      v_pointage_id,
      v_session_id,
      v_session_start,
      false;
end;
$$;
