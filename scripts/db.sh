#!/bin/sh
# Local development Postgres (project-local cluster in .pgdata, port 54330).
#   ./scripts/db.sh start|stop|status|setup
# Roles: "proofly" owns the schema and runs migrations (DIRECT_DATABASE_URL);
#        "proofly_app" is what the application connects as (DATABASE_URL). It is NOT a superuser and has
#        NOBYPASSRLS, so Postgres row-level security applies to every application query.
PG=$(brew --prefix postgresql@17)/bin
export LC_ALL=en_US.UTF-8
[ -d .pgdata ] || "$PG/initdb" -D .pgdata -U proofly --auth=trust -E UTF8 --locale=C >/dev/null
psql() { "$PG/psql" -h localhost -p 54330 -U proofly -v ON_ERROR_STOP=1 -q "$@"; }
case "$1" in
  start) "$PG/pg_ctl" -D .pgdata -o "-p 54330 -k /tmp -c listen_addresses=localhost" -l .pgdata/log.txt -w start ;;
  stop) "$PG/pg_ctl" -D .pgdata stop ;;
  setup)
    psql -d postgres -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'proofly_app') THEN CREATE ROLE proofly_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END \$\$;"
    for db in proofly_dev proofly_test; do
      psql -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1 || psql -d postgres -c "CREATE DATABASE $db OWNER proofly"
      psql -d "$db" -c "GRANT USAGE ON SCHEMA public TO proofly_app; ALTER DEFAULT PRIVILEGES FOR ROLE proofly IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO proofly_app; ALTER DEFAULT PRIVILEGES FOR ROLE proofly IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO proofly_app;"
    done ;;
  *) "$PG/pg_ctl" -D .pgdata status ;;
esac
