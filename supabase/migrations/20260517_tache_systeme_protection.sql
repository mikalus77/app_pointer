alter table public.tache
add column if not exists tache_systeme boolean not null default false;

update public.tache
set tache_systeme = true,
    actif = true
where lower(trim(titre_tache)) in (
  lower('Autre tâche'),
  lower('Autre activité')
);

create or replace function public.prevent_system_task_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and old.tache_systeme then
    raise exception 'Cannot delete a system task';
  end if;

  if tg_op = 'UPDATE' and old.tache_systeme then
    if new.actif is distinct from old.actif then
      raise exception 'Cannot change actif on a system task';
    end if;

    if new.tache_systeme is distinct from old.tache_systeme then
      raise exception 'Cannot change tache_systeme on a system task';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_prevent_system_task_mutation on public.tache;

create trigger trg_prevent_system_task_mutation
before update or delete on public.tache
for each row
execute function public.prevent_system_task_mutation();
