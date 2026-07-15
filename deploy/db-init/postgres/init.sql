-- scalaradmin user + default database (the config's postgres.database default, db_postgres).
-- Equivalent to the init ConfigMap of the postgres db-pod manifests.
CREATE USER scalaradmin WITH PASSWORD 'scalaradmin';
ALTER USER scalaradmin CREATEDB;
CREATE DATABASE db_postgres OWNER scalaradmin;
