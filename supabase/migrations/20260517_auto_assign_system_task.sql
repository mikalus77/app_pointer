create or replace function public.assign_system_task_to_user()
returns trigger
language plpgsql
as $$
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
  where t.tache_systeme = true
    and t.actif = true
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
$$;

drop trigger if exists trg_assign_system_task_to_user on public.utilisateur;

create trigger trg_assign_system_task_to_user
after insert or update of id_statut_utilisateur on public.utilisateur
for each row
execute function public.assign_system_task_to_user();

insert into public.utilisateur_tache (id_utilisateur, id_tache)
select u.id_utilisateur, t.id_tache
from public.utilisateur u
join public.statut_utilisateur su
  on su.id_statut_utilisateur = u.id_statut_utilisateur
 and su.code_statut_utilisateur = 'ACTIVE'
join public.tache t on t.tache_systeme = true and t.actif = true
where not exists (
  select 1
  from public.utilisateur_tache ut
  where ut.id_utilisateur = u.id_utilisateur
    and ut.id_tache = t.id_tache
);

