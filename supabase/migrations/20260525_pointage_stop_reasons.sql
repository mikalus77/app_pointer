create or replace function public.rpc_pointage_resume(
  p_pause_id integer,
  p_pause_comment text default null
)
returns table (
  fin_pause_pointage timestamp with time zone
)
language plpgsql
security definer
as $$
declare
  v_user_id integer;
  v_pause_end timestamp with time zone;
  v_manual_reason_id bigint;
begin
  select p.id_utilisateur_pointeur
  into v_user_id
  from public.pause_pointage pp
  join public.session_pointage s on s.id_session_pointage = pp.id_session_pointage
  join public.pointage p on p.id_pointage = s.id_pointage
  where pp.id_pause_pointage = p_pause_id
  limit 1;

  if v_user_id is null then
    raise exception 'Pause not found';
  end if;

  perform pg_advisory_xact_lock(71002, v_user_id);

  select mas.id_motif_arret_session
  into v_manual_reason_id
  from public.motif_arret_session mas
  where mas.code_motif_arret_session = 'ARRET_MANUEL'
    and mas.actif = true
  limit 1;

  if v_manual_reason_id is null then
    raise exception 'Stop reason ARRET_MANUEL not configured';
  end if;

  update public.pause_pointage as pp
  set
    fin_pause_pointage = now(),
    commentaire_pause_pointage = p_pause_comment,
    id_motif_arret_session = v_manual_reason_id
  where pp.id_pause_pointage = p_pause_id
    and pp.fin_pause_pointage is null
  returning pp.fin_pause_pointage
  into v_pause_end;

  if v_pause_end is null then
    raise exception 'No active pause to resume';
  end if;

  return query select v_pause_end;
end;
$$;

create or replace function public.rpc_pointage_stop(
  p_session_id integer,
  p_session_comment text default null,
  p_pause_id integer default null,
  p_pause_comment text default null,
  p_stop_reason_code text default 'ARRET_MANUEL'
)
returns table (
  fin_session_pointage timestamp with time zone,
  fin_pause_pointage timestamp with time zone
)
language plpgsql
security definer
as $$
declare
  v_user_id integer;
  v_session_end timestamp with time zone;
  v_pause_end timestamp with time zone;
  v_reason_id bigint;
begin
  select p.id_utilisateur_pointeur
  into v_user_id
  from public.session_pointage s
  join public.pointage p on p.id_pointage = s.id_pointage
  where s.id_session_pointage = p_session_id
  limit 1;

  if v_user_id is null then
    raise exception 'Session not found';
  end if;

  perform pg_advisory_xact_lock(71002, v_user_id);

  select mas.id_motif_arret_session
  into v_reason_id
  from public.motif_arret_session mas
  where mas.code_motif_arret_session = p_stop_reason_code
    and mas.actif = true
  limit 1;

  if v_reason_id is null then
    raise exception 'Stop reason code is invalid or inactive';
  end if;

  if p_pause_id is not null then
    update public.pause_pointage as pp
    set
      fin_pause_pointage = now(),
      commentaire_pause_pointage = p_pause_comment,
      id_motif_arret_session = v_reason_id
    where pp.id_pause_pointage = p_pause_id
      and pp.id_session_pointage = p_session_id
      and pp.fin_pause_pointage is null
    returning pp.fin_pause_pointage
    into v_pause_end;
  end if;

  update public.session_pointage as sp
  set
    fin_session_pointage = now(),
    commentaire_session_pointage = p_session_comment,
    id_motif_arret_session = v_reason_id
  where sp.id_session_pointage = p_session_id
    and sp.fin_session_pointage is null
  returning sp.fin_session_pointage
  into v_session_end;

  if v_session_end is null then
    raise exception 'Session is already closed or missing';
  end if;

  return query select v_session_end, v_pause_end;
end;
$$;

create or replace function public.rpc_pointage_apply_auto_closure(
  p_user_id integer,
  p_work_grace_minutes integer default 10,
  p_pause_max_minutes integer default 70
)
returns table (
  closed_session_id integer,
  closed_pause_id integer,
  session_end_at timestamp with time zone,
  pause_end_at timestamp with time zone
)
language plpgsql
security definer
as $$
declare
  v_session_id integer;
  v_session_start timestamp with time zone;
  v_session_last_seen timestamp with time zone;
  v_pause_id integer;
  v_pause_start timestamp with time zone;
  v_pause_last_seen timestamp with time zone;
  v_now timestamp with time zone;
  v_session_deadline timestamp with time zone;
  v_pause_deadline timestamp with time zone;
  v_min_end_offset interval := interval '1 second';
  v_auto_reason_id bigint;
begin
  perform pg_advisory_xact_lock(71002, p_user_id);
  v_now := now();

  select mas.id_motif_arret_session
  into v_auto_reason_id
  from public.motif_arret_session mas
  where mas.code_motif_arret_session = 'ARRET_AUTO'
    and mas.actif = true
  limit 1;

  if v_auto_reason_id is null then
    raise exception 'Stop reason ARRET_AUTO not configured';
  end if;

  select s.id_session_pointage, s.debut_session_pointage, s.last_seen_session_pointage
  into v_session_id, v_session_start, v_session_last_seen
  from public.session_pointage s
  join public.pointage p on p.id_pointage = s.id_pointage
  where p.id_utilisateur_pointeur = p_user_id
    and s.fin_session_pointage is null
  order by s.debut_session_pointage desc
  limit 1;

  if v_session_id is null then
    return;
  end if;

  select pp.id_pause_pointage, pp.debut_pause_pointage, pp.last_seen_pause_pointage
  into v_pause_id, v_pause_start, v_pause_last_seen
  from public.pause_pointage pp
  where pp.id_session_pointage = v_session_id
    and pp.fin_pause_pointage is null
  order by pp.debut_pause_pointage desc
  limit 1;

  if v_pause_id is not null then
    v_pause_deadline := greatest(
      v_pause_start + v_min_end_offset,
      v_pause_start + make_interval(mins => greatest(p_pause_max_minutes, 0))
    );

    if v_now > v_pause_deadline then
      update public.pause_pointage pp
      set
        fin_pause_pointage = v_pause_deadline,
        commentaire_pause_pointage = coalesce(pp.commentaire_pause_pointage, 'Pause arretee automatiquement apres 1h10 d''inactivite.'),
        last_seen_pause_pointage = coalesce(v_pause_last_seen, v_pause_deadline),
        id_motif_arret_session = v_auto_reason_id
      where pp.id_pause_pointage = v_pause_id
        and pp.fin_pause_pointage is null;

      update public.session_pointage s
      set last_seen_session_pointage = greatest(coalesce(s.last_seen_session_pointage, s.debut_session_pointage), v_pause_deadline)
      where s.id_session_pointage = v_session_id;

      closed_session_id := null;
      closed_pause_id := v_pause_id;
      session_end_at := null;
      pause_end_at := v_pause_deadline;
      return next;
      return;
    end if;

    return;
  end if;

  v_session_deadline := greatest(
    v_session_start + v_min_end_offset,
    coalesce(v_session_last_seen, v_session_start) + make_interval(mins => greatest(p_work_grace_minutes, 0))
  );

  if v_now > v_session_deadline then
    update public.session_pointage s
    set
      fin_session_pointage = v_session_deadline,
      commentaire_session_pointage = coalesce(s.commentaire_session_pointage, 'Session arretee automatiquement apres 10 minutes d''inactivite.'),
      last_seen_session_pointage = coalesce(v_session_last_seen, v_session_deadline),
      id_motif_arret_session = v_auto_reason_id
    where s.id_session_pointage = v_session_id
      and s.fin_session_pointage is null;

    closed_session_id := v_session_id;
    closed_pause_id := null;
    session_end_at := v_session_deadline;
    pause_end_at := null;
    return next;
    return;
  end if;
end;
$$;
