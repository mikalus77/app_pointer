create or replace function public.rpc_pointage_apply_auto_closure(
  p_user_id integer,
  p_work_grace_minutes integer default 5,
  p_pause_max_minutes integer default 65
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
  v_inactivity_reason_id bigint;
begin
  perform pg_advisory_xact_lock(71002, p_user_id);
  v_now := now();

  select mas.id_motif_arret_session
  into v_inactivity_reason_id
  from public.motif_arret_session mas
  where mas.code_motif_arret_session = 'INACTIVITE'
    and mas.actif = true
  limit 1;

  if v_inactivity_reason_id is null then
    raise exception 'Stop reason INACTIVITE not configured';
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
      coalesce(v_pause_last_seen, v_pause_start) + make_interval(mins => greatest(p_pause_max_minutes, 0))
    );

    if v_now > v_pause_deadline then
      update public.pause_pointage pp
      set
        fin_pause_pointage = v_pause_deadline,
        last_seen_pause_pointage = coalesce(v_pause_last_seen, v_pause_deadline),
        id_motif_arret_session = v_inactivity_reason_id
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
      last_seen_session_pointage = coalesce(v_session_last_seen, v_session_deadline),
      id_motif_arret_session = v_inactivity_reason_id
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
