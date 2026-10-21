// Writes an append-only audit record. Pass a transaction client so the audit row
// commits atomically with the change it describes.
async function audit(db, { actorId, action, entity, entityId, metadata = {}, req }) {
  await db.query(
    `INSERT INTO audit_logs (actor_id, action, entity, entity_id, metadata, ip, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actorId || null, action, entity, entityId ? String(entityId) : null, metadata, req?.ip || null, req?.id || null]
  );
}

module.exports = { audit };
