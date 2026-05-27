-- Finalize task status migration:
-- - remove remaining dependency on public.tache.actif
-- - keep system task protections
-- - drop public.tache.actif safely

create or replace function public.prevent_system_task_mutation()
returns trigger
language plpgsql
as $function$
begin
  if old.tache_systeme = true then
    if new.titre_tache is distinct from old.titre_tache
       or new.description_tache is distinct from old.description_tache
       or new.duree_prevue_minutes is distinct from old.duree_prevue_minutes
       or new.date_echeance_tache is distinct from old.date_echeance_tache
       or new.id_statut_tache is distinct from old.id_statut_tache then
      raise exception 'Cannot modify protected fields on a system task';
    end if;
  end if;

  return new;
end;
$function$;

create or replace function public.assign_system_task_to_user()
returns trigger
language plpgsql
as $function$
declare
  v_system_task_id integer;
  v_is_active boolean;
begin
  select exists (
    select 1
    from public.statut_utilisateur su
    where su.id_statut_utilisateur = new.id_statut_utilisateur
      and su.code_statut_utilisateur = 'ACTIVE'
  )
  into v_is_active;

  if coalesce(v_is_active, false) is not true then
    return new;
  end if;

  select t.id_tache
  into v_system_task_id
  from public.tache t
  join public.statut_tache st on st.id_statut_tache = t.id_statut_tache
  where t.tache_systeme = true
    and st.code_statut_tache = 'EN_COURS'
  order by t.id_tache asc
  limit 1;

  if v_system_task_id is null then
    return new;
  end if;

  insert into public.utilisateur_tache (id_utilisateur, id_tache)
  values (new.id_utilisateur, v_system_task_id)
  on conflict do nothing;

  return new;
end;
$function$;

alter table if exists public.tache
  drop column if exists actif;
