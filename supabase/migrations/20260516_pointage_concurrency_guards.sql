create unique index if not exists uq_session_pointage_active_per_pointage
on public.session_pointage (id_pointage)
where fin_session_pointage is null;

create unique index if not exists uq_pause_pointage_active_per_session
on public.pause_pointage (id_session_pointage)
where fin_pause_pointage is null;
