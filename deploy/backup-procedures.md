# OrchestraAI Backup & Restore Procedures
# -------------------------------------
# This document describes backup and restore procedures for a production
# OrchestraAI deployment. Review regularly and test restore procedures.

## Backup Scope

### What to Back Up

1. **Runtime Data Volume** (`RUNTIME_DATA_DIR`, default: `backend/.runtime-data`)
   - Run index, events, snapshots, intelligence, evaluations
   - Provider credentials (encrypted with DATA_ENCRYPTION_KEY)
   - Idempotency records
   - **Critical**: Back up together with the encryption key

2. **PostgreSQL Database** (authoritative in the compose deployment)
   - `orchestraai` database
   - Contains users, sessions, organizations, projects, run index, run
     events, snapshots, idempotency, evaluations, intelligence docs,
     billing records, and the audit log

3. **Object storage** (not deployed by default)
   - The default compose deployment keeps run artifacts in Postgres
     (JSONB snapshots, bounded) and the runtime data volume. No object
     store is provisioned because no application path currently requires
     one. If you add S3-compatible storage later: private buckets only,
     no public policies, tenant-scoped keys, signed URLs, lifecycle
     policies — then extend this procedure with bucket mirroring.

4. **DATA_ENCRYPTION_KEY**
   - **MUST be backed up separately** from the runtime data volume
   - Without this key, stored provider credentials are irrecoverable
   - Store in a separate secrets manager (HashiCorp Vault, AWS KMS, etc.)
   - Never store the key alongside the data it encrypts

### What NOT to Back Up

- Docker images (rebuild from Dockerfile)
- node_modules (reinstall from package.json)
- frontend/dist (rebuild with `npm run build:frontend`)
- .git metadata (already in version control)
- Runtime logs (rotatable, not persistent state)

## Backup Procedures

### 1. Runtime Data Volume Backup

```bash
# Using docker cp (if using the orchestraai container)
docker cp $(docker compose -f deploy/docker-compose.yml ps -q api):/var/lib/orchestraai ./runtime-data-backup-$(date +%Y%m%d-%H%M%S).tar

# Or using a named volume
docker volume cp <volume-name>:/path ./backup-dir
```

**Recommended**: Use `tar` inside the running container:

```bash
docker exec $(docker compose -f deploy/docker-compose.yml ps -q api) \
  tar czf /tmp/runtime-data-backup-$(date +%Y%m%d-%H%M%S).tar -C /var/lib/orchestraai .

docker cp $(docker compose -f deploy/docker-compose.yml ps -q api):/tmp/runtime-data-backup-$(date +%Y%m%d-%H%M%S).tar ./runtime-data-backup-$(date +%Y%m%d-%H%M%S).tar
```

### 2. PostgreSQL Backup

```bash
# Using pg_dump with the postgres service
docker compose -f deploy/docker-compose.yml exec postgres \
  pg_dump -U orchestraai orchestraai > postgres-backup-$(date +%Y%m%d-%H%M%S).sql

# Or using docker run with the postgres image
docker run --rm --volumes-from <postgres-container-name> \
  -v $(pwd):/backup alpine tar czf /backup/postgres-data-backup-$(date +%Y%m%d-%H%M%S).tar /var/lib/postgresql/data
```

**Retention**: Keep at least 7 daily, 4 weekly, and 1 monthly backup.

### 3. Object-storage backup (only if you provisioned one)

The default deployment provisions no object store (see item 3 above), so
there is nothing to back up here. If you added S3-compatible storage,
mirror the private buckets with versioning enabled, e.g.:

```bash
aws s3 sync s3://orchestraai-artifacts s3://orchestraai-artifacts-backup-$(date +%Y%m%d) --only-show-errors
```

### 4. Encryption Key Backup

**This is the most critical backup.** The DATA_ENCRYPTION_KEY must be backed up
separately and never stored alongside the encrypted data.

- Store in a secrets manager (recommended)
- Or write to an offline, sealed container (air-gapped, fire-safe storage)
- Rotate periodically and maintain a rotation history
- **Warning**: Loss of the DATA_ENCRYPTION_KEY means all stored provider
  credentials become unrecoverable. The system will refuse to start in
  production without this key.

## Restore Procedures

### 1. Restore Runtime Data Volume

```bash
# Stop the service
docker compose -f deploy/docker-compose.yml stop api

# Restore the tar backup
docker cp runtime-data-backup-20240101-000000.tar $(docker compose -f deploy/docker-compose.yml ps -q api):/tmp/restore.tar

# Extract inside the container (then start)
docker exec $(docker compose -f deploy/docker-compose.yml ps -q api) \
  tar xzf /tmp/restore.tar -C /var/lib/orchestraai/

# Verify the restore
docker compose -f deploy/docker-compose.yml start api
```

### 2. Restore PostgreSQL

The backup above is a plain-SQL `pg_dump`, so restore it with `psql` (not
`pg_restore`, which expects a `-Fc` custom-format archive):

```bash
# Restore into an empty database (schema_migrations is recreated by the SQL).
docker compose -f deploy/docker-compose.yml exec -T postgres \
  psql -U orchestraai -d orchestraai < postgres-backup-YYYYMMDD-HHMMSS.sql

# Verify: migrations + row counts.
docker compose -f deploy/docker-compose.yml exec postgres \
  psql -U orchestraai -c "SELECT version, applied_at FROM schema_migrations ORDER BY version;"
docker compose -f deploy/docker-compose.yml exec postgres \
  psql -U orchestraai -c "SELECT count(*) FROM run_index; SELECT count(*) FROM users;"
```

**RPO / RTO**: with daily `pg_dump` the recovery point is the last successful
dump (≤24h for default guidance). Restore of a plain-SQL dump into an empty
image database completes in seconds-to-minutes depending on data size. Test
the restore to a staging database at least quarterly.

### 3. Restore object storage (only if you provisioned one)

The default deployment provisions **no object store**, so there is nothing to
restore here. If you added S3-compatible storage, restore a private bucket
snapshot (never public), then verify tenant-scoped keys:

```bash
aws s3 sync s3://orchestraai-artifacts-backup-YYYYMMDD s3://orchestraai-artifacts --only-show-errors
```

### 4. Restore DATA_ENCRYPTION_KEY

If the encryption key is lost, there is no technical way to recover stored
provider credentials. Restoration from a separate key backup is the only path.
If no key backup exists, stored credentials must be reconfigured from scratch.

## Retention Guidance

| Medium         | Keep          | Rotation  |
|----------------|---------------|-----------|
| Runtime data   | 14 daily, 8 weekly, 4 monthly | Weekly full, daily incremental |
| PostgreSQL     | 7 daily, 4 weekly, 1 monthly   | Daily full (`pg_dump`)   |
| Object storage | (none by default) | n/a (not provisioned) |
| Encryption key | Permanent, off-site, immutable   | Rotate annually, keep all versions |

## Disaster Recovery Checklist

- [ ] Runtime data volume backed up within last 24 hours
- [ ] PostgreSQL backup verified (restore to staging, check data integrity)
- [ ] DATA_ENCRYPTION_KEY stored in separate location, tested accessible
- [ ] Docker Compose file matches current production topology
- [ ] Test restore performed in staging environment within last 90 days
- [ ] Key rotation record up to date
- [ ] Backup procedure documented and assigned to responsible operator