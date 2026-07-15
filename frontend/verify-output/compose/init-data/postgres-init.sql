-- ScalarRE PostgreSQL initialization for Docker Compose
-- Creates the application user and database.

CREATE USER scalaradmin WITH PASSWORD 'scalaradmin';
ALTER USER scalaradmin CREATEDB;

CREATE DATABASE db_postgres OWNER scalaradmin;
