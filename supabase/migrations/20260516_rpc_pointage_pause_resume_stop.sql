create or replace function public.rpc_pointage_pause(
  p_session_id integer
)
returns table (
  id_pause_pointage integer,
  debut_pause_pointage timestamp with time zone
)
language plpgsql
security definer
as $$
declare
  v_user_id integer;
  v_pause_id integer;
  v_pause_start timestamp with time zone;
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

  if exists (
    select 1
    from public.pause_pointage pp
    where pp.id_session_pointage = p_session_id
      and pp.fin_pause_pointage is null
  ) then
    raise exception 'An active pause already exists for this session';
  end if;

  if exists (
    select 1
    from public.session_pointage s
    where s.id_session_pointage = p_session_id
      and s.fin_session_pointage is not null
  ) then
    raise exception 'Cannot pause a closed session';
  end if;

  insert into public.pause_pointage (
    id_session_pointage,
    fin_pause_pointage,
    commentaire_pause_pointage
  ) values (
    p_session_id,
    null,
    null
  )
  returning public.pause_pointage.id_pause_pointage, public.pause_pointage.debut_pause_pointage
  into v_pause_id, v_pause_start;

  return query select v_pause_id, v_pause_start;
end;
$$;

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

  update public.pause_pointage as pp
  set
    fin_pause_pointage = now(),
    commentaire_pause_pointage = p_pause_comment
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
  p_pause_comment text default null
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

  if p_pause_id is not null then
    update public.pause_pointage as pp
    set
      fin_pause_pointage = now(),
      commentaire_pause_pointage = p_pause_comment
    where pp.id_pause_pointage = p_pause_id
      and pp.id_session_pointage = p_session_id
      and pp.fin_pause_pointage is null
    returning pp.fin_pause_pointage
    into v_pause_end;
  end if;

  update public.session_pointage as sp
  set
    fin_session_pointage = now(),
    commentaire_session_pointage = p_session_comment
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
