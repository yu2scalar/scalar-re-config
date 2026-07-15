-- ScalarRE MySQL initialization for Docker Compose
-- Creates the application user with required privileges.

CREATE USER IF NOT EXISTS 'scalaradmin'@'%' IDENTIFIED BY 'scalaradmin';

-- ScalarDB requires: CREATE, DROP, ALTER, SELECT, INSERT, UPDATE, DELETE
-- on all databases it manages (scalarre, ns_mysql, plus ScalarDB metadata).
GRANT CREATE, DROP, ALTER, INDEX, SELECT, INSERT, UPDATE, DELETE
  ON *.* TO 'scalaradmin'@'%';

FLUSH PRIVILEGES;
