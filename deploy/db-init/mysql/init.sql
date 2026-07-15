-- scalaradmin user (the config's default username/password).
-- Grants broadly on *.* so ScalarDB admin can create arbitrary namespaces (= schemas).
-- Equivalent to the init ConfigMap of the mysql db-pod manifests.
CREATE USER IF NOT EXISTS 'scalaradmin'@'%' IDENTIFIED BY 'scalaradmin';
GRANT CREATE, DROP, ALTER, INDEX, SELECT, INSERT, UPDATE, DELETE
  ON *.* TO 'scalaradmin'@'%';
