-- Runtime migration commits 0152 before validating existing configuration rows.
ALTER TABLE "device_grant_configurations" VALIDATE CONSTRAINT "device_grant_configurations_activation_fk";
