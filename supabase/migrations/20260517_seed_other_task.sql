insert into public.tache (titre_tache, actif)
select 'Autre tâche', true
where not exists (
  select 1
  from public.tache
  where lower(trim(titre_tache)) in (
    lower('Autre tâche'),
    lower('Autre activit\u00E9')
  )
);
