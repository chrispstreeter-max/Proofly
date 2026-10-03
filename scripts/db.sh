#!/bin/sh
# Local development Postgres (project-local cluster in .pgdata, port 54330). Usage: ./scripts/db.sh start|stop|status
PG=$(brew --prefix postgresql@17)/bin
export LC_ALL=en_US.UTF-8
[ -d .pgdata ] || "$PG/initdb" -D .pgdata -U proofly --auth=trust -E UTF8 --locale=C >/dev/null
case "$1" in
  start) "$PG/pg_ctl" -D .pgdata -o "-p 54330 -k /tmp -c listen_addresses=localhost" -l .pgdata/log.txt -w start ;;
  stop) "$PG/pg_ctl" -D .pgdata stop ;;
  *) "$PG/pg_ctl" -D .pgdata status ;;
esac
