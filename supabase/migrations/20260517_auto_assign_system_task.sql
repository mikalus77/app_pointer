create or replace function public.assign_system_task_to_user()
returns trigger
language plpgsql
as $$
declare
  v_system_task_id integer;
begin
  if new.actif is not true then
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
after insert or update of actif on public.utilisateur
for each row
execute function public.assign_system_task_to_user();

insert into public.utilisateur_tache (id_utilisateur, id_tache)
select u.id_utilisateur, t.id_tache
from public.utilisateur u
join public.tache t on t.tache_systeme = true and t.actif = true
where u.actif = true
  and not exists (
    select 1
    from public.utilisateur_tache ut
    where ut.id_utilisateur = u.id_utilisateur
      and ut.id_tache = t.id_tache
  );
