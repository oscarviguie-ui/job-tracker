alter table public.companies drop constraint companies_ats_check;
alter table public.companies add constraint companies_ats_check
  check (ats in ('workday','smartrecruiters','greenhouse','lever','ashby','recruitee','teamtailor','personio','oracle','successfactors','pinpoint','links','unknown'));
